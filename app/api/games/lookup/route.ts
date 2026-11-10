import { NextResponse } from "next/server";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { safeFetch, SsrfBlockedError, HtmlTooLargeError, fetchTextWithLimit, MAX_HTML_SIZE } from "@/lib/fetch-rulebook-utils";

/**
 * Look up a board game by name. Tries BGG first (most complete data),
 * falls back to Wikipedia's API if BGG is unreachable or blocks us.
 * Uses fuzzy name matching and optional publisher hint for disambiguation.
 * No API key required — just fetches public pages.
 */

interface LookupResult {
  title: string;
  players?: string;
  playtimeMinutes?: number;
  ageRating?: string;
  description?: string;
  tags?: string[];
  publisherUrl?: string;
  publisherName?: string;
  bggUrl?: string;
  wikiUrl?: string;
  webUrl?: string;
  source: "bgg" | "wikipedia" | "web" | "none";
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export async function POST(req: Request) {
  const start = Date.now();
  const ip = getClientIp(req);

  // Rate limit: 5 per minute (be polite to external sites).
  const rate = checkRate(ip, "/api/games/lookup", 5, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: "/api/games/lookup", method: "POST", status: 429, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Too many lookups — wait a minute." }, { status: 429 });
  }

  let body: { name?: string; publisher?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    logRequest({ ip, route: "/api/games/lookup", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Game name is required" }, { status: 400 });
  }

  const publisher = body.publisher?.trim() ?? null;

  // Try BGG first.
  try {
    const bggResult = await lookupBgg(name);
    if (bggResult) {
      logRequest({ ip, route: "/api/games/lookup", method: "POST", status: 200, durationMs: Date.now() - start });
      return NextResponse.json(bggResult);
    }
  } catch (e) {
    console.log(`lookup: BGG failed (${e instanceof Error ? e.message : e}), trying Wikipedia`);
  }

  // Fall back to Wikipedia with fuzzy search.
  try {
    const wikiResult = await lookupWikipedia(name, publisher);
    if (wikiResult) {
      logRequest({ ip, route: "/api/games/lookup", method: "POST", status: 200, durationMs: Date.now() - start });
      return NextResponse.json(wikiResult);
    }
  } catch (e) {
    console.log(`lookup: Wikipedia failed (${e instanceof Error ? e.message : e})`);
  }

  // Fall back to a wider web search (official publisher sources only).
  try {
    const webResult = await lookupWeb(name, publisher);
    if (webResult) {
      logRequest({ ip, route: "/api/games/lookup", method: "POST", status: 200, durationMs: Date.now() - start });
      return NextResponse.json(webResult);
    }
  } catch (e) {
    console.log(`lookup: web search failed (${e instanceof Error ? e.message : e})`);
  }

  logRequest({ ip, route: "/api/games/lookup", method: "POST", status: 404, durationMs: Date.now() - start });
  return NextResponse.json(
    { error: `No results found for "${name}". Try a shorter name or add the publisher.` },
    { status: 404 }
  );
}

// ─── BGG Lookup ─────────────────────────────────────────────────────────────

async function lookupBgg(name: string): Promise<LookupResult | null> {
  const searchUrl = `https://boardgamegeek.com/bggsearch?q=${encodeURIComponent(name)}`;
  let searchHtml: string;
  try {
    // Guarded fetch with a size cap: defense-in-depth even for hardcoded
    // trusted domains.
    searchHtml = await fetchTextWithLimit(searchUrl, MAX_HTML_SIZE, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    if (e instanceof SsrfBlockedError || e instanceof HtmlTooLargeError) {
      console.log(`lookup: BGG search skipped (${e.message})`);
    }
    return null; // skip gracefully on any fetch failure
  }

  // Find the first game result link.
  const match = searchHtml.match(/href="\/thing\/(\d+)[^"]*"[^>]*>([^<]+)/i);
  if (!match) return null;

  const thingId = match[1];
  const bggUrl = `https://boardgamegeek.com/thing/${thingId}`;

  let gameHtml: string;
  try {
    // Guarded fetch with a size cap: defense-in-depth even for hardcoded
    // trusted domains.
    gameHtml = await fetchTextWithLimit(bggUrl, MAX_HTML_SIZE, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    if (e instanceof SsrfBlockedError || e instanceof HtmlTooLargeError) {
      console.log(`lookup: BGG page skipped (${e.message})`);
    }
    return null; // skip gracefully on any fetch failure
  }

  const result: LookupResult = { title: name, bggUrl, source: "bgg" };

  // Title.
  const titleMatch = gameHtml.match(/<title>\s*([^<]+?)\s*[-|]/i);
  if (titleMatch) result.title = stripHtml(titleMatch[1]);

  // Players.
  const playersMatch = gameHtml.match(/For\s+(\d+)\s*to\s*(\d+)\s*players/i)
    || gameHtml.match(/For\s+(\d+)\s*players/i)
    || gameHtml.match(/(\d+)\s*[-–]\s*(\d+)\s*players/i);
  if (playersMatch) {
    result.players = playersMatch[2] ? `${playersMatch[1]}-${playersMatch[2]}` : playersMatch[1];
  }

  // Playtime.
  const timeMatch = gameHtml.match(/(?:playing\s+time|playtime)[^0-9]*(\d+)\s*min/i)
    || gameHtml.match(/approximately\s+(\d+)\s*min/i)
    || gameHtml.match(/(\d+)\s*minutes/i);
  if (timeMatch) result.playtimeMinutes = Number(timeMatch[1]);

  // Age.
  const ageMatch = gameHtml.match(/ages?\s*(\d+)\s*\+/i)
    || gameHtml.match(/recommended\s+for\s+ages?\s*(\d+)/i);
  if (ageMatch) result.ageRating = `${ageMatch[1]}+`;

  // Description.
  const descMatch = gameHtml.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  if (descMatch) result.description = stripHtml(descMatch[1]).slice(0, 500);

  // Publisher.
  const pubMatch = gameHtml.match(/publisher[^>]*>.*?href="([^"]+)"[^>]*>([^<]+)/i);
  if (pubMatch) {
    result.publisherUrl = pubMatch[1];
    result.publisherName = stripHtml(pubMatch[2]);
  }

  // Tags/genres.
  const genres: string[] = [];
  const genrePattern = /href="\/geekitem\?id=(\d+)"[^>]*>([^<]{3,30})</gi;
  for (const m of gameHtml.matchAll(genrePattern)) {
    const g = stripHtml(m[2]);
    if (g && !genres.includes(g)) genres.push(g);
  }
  if (genres.length > 0) result.tags = genres.slice(0, 5);

  return result;
}

// ─── Wikipedia Lookup (with fuzzy search) ────────────────────────────────────

/**
 * Generate search query variations from a game name, ordered by likelihood.
 * "Nemesis: Lockdown" → ["Nemesis: Lockdown board game", "Nemesis Lockdown board game", "Nemesis board game"]
 */
function nameVariations(name: string): string[] {
  const variations: string[] = [];

  // 1. Exact name + "board game"
  variations.push(`${name} board game`);

  // 2. Remove special chars (colons, dashes) + "board game"
  const cleaned = name.replace(/[:\-–—]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned !== name) {
    variations.push(`${cleaned} board game`);
  }

  // 3. Just the main title (before colon/dash) + "board game"
  const mainTitle = name.split(/[:\-–—]/)[0].trim();
  if (mainTitle && mainTitle !== name) {
    variations.push(`${mainTitle} board game`);
  }

  // 4. Main title alone (no "board game" suffix)
  if (mainTitle && mainTitle !== name) {
    variations.push(mainTitle);
  }

  // 5. Full cleaned name without "board game"
  if (cleaned !== name) {
    variations.push(cleaned);
  }

  return [...new Set(variations)];
}

async function lookupWikipedia(name: string, publisher?: string | null): Promise<LookupResult | null> {
  const variations = nameVariations(name);

  // Try each variation until we find a Wikipedia article.
  let articleTitle: string | null = null;
  for (const query of variations) {
    const title = await wikiSearch(query);
    if (title) {
      articleTitle = title;
      break;
    }
  }

  if (!articleTitle) return null;

  // Fetch the article and extract metadata.
  const result = await wikiExtract(articleTitle, name);

  // If a publisher hint was provided, verify it matches.
  // This helps disambiguate when the fuzzy match found a similar-but-wrong game.
  if (publisher && result.publisherName) {
    const pubLower = result.publisherName.toLowerCase();
    const hintLower = publisher.toLowerCase();
    if (!pubLower.includes(hintLower) && !hintLower.includes(pubLower)) {
      // Publisher doesn't match — this might be the wrong game.
      // Still return the result (it's the best we have), but don't trust the publisher field.
      console.log(`lookup: publisher hint "${publisher}" doesn't match found "${result.publisherName}"`);
    }
  } else if (publisher && !result.publisherName) {
    // No publisher in the article — can't verify. Leave as-is.
  }

  return result;
}

/** Search Wikipedia and return the first article title, or null. */
async function wikiSearch(query: string): Promise<string | null> {
  try {
    const res = await safeFetch(
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&format=json`,
      {
        headers: { "User-Agent": "BoardGameParlor/1.0 (self-hosted catalog)" },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const titles: string[] = data[1] ?? [];
    // Prefer titles that contain "board game" or are exact matches.
    const boardGameMatch = titles.find((t) => t.toLowerCase().includes("board game"));
    return boardGameMatch ?? titles[0] ?? null;
  } catch {
    return null;
  }
}

/** Fetch a Wikipedia article and extract structured metadata. */
async function wikiExtract(articleTitle: string, displayName: string): Promise<LookupResult> {
  const result: LookupResult = {
    title: displayName,
    source: "wikipedia",
    wikiUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(articleTitle).replace(/%20/g, "_")}`,
  };

  // Fetch wikitext (for infobox fields).
  let text = "";
  try {
    const parseRes = await safeFetch(
      `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(articleTitle)}&prop=wikitext&redirects=1&format=json`,
      {
        headers: { "User-Agent": "BoardGameParlor/1.0 (self-hosted catalog)" },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (parseRes.ok) {
      const parseData = await parseRes.json();
      const wt = parseData.parse?.wikitext;
      text = typeof wt === "string" ? wt : (wt as any)?.["*"] ?? "";
    }
  } catch {
    /* continue with empty text */
  }

  // Description via plain-text extract API.
  try {
    const extractRes = await safeFetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(articleTitle)}&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json`,
      {
        headers: { "User-Agent": "BoardGameParlor/1.0 (self-hosted catalog)" },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (extractRes.ok) {
      const extractData = await extractRes.json();
      const pages = extractData.query?.pages;
      const page = pages && Object.values(pages)[0];
      if (page?.extract) {
        result.description = page.extract.slice(0, 400);
      }
    }
  } catch {
    /* non-critical */
  }

  // Players.
  const playersMatch = text.match(/\|\s*players\s*=\s*\{\{ubl\|([^}]+)/i)
    || text.match(/\|\s*players\s*=\s*(\d+)\s*[-–]\s*(\d+)/i)
    || text.match(/\|\s*players\s*=\s*(\d+)/i);
  if (playersMatch) {
    // Pattern 2 captures a range directly in groups 1 and 2.
    if (playersMatch[1] && playersMatch[2]) {
      result.players = `${playersMatch[1]}-${playersMatch[2]}`;
    } else {
      const val = playersMatch[1];
      const nums = val.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (nums) {
        result.players = `${nums[1]}-${nums[2]}`;
      } else {
        const single = val.match(/(\d+)/);
        if (single) result.players = single[1];
      }
    }
  }

  // Playtime: "1–2 hours" → convert to minutes.
  const timeMatch = text.match(/\|\s*playing[_ ]?time\s*=\s*(\d+)\s*[-–]\s*(\d+)\s*hours?/i)
    || text.match(/\|\s*playing[_ ]?time\s*=\s*(\d+)\s*hours?/i)
    || text.match(/\|\s*playing[_ ]?time\s*=\s*(\d+)\s*minutes?/i);
  if (timeMatch) {
    const hours = Number(timeMatch[1]);
    result.playtimeMinutes = hours <= 24 ? hours * 60 : hours;
  }

  // Age.
  const ageMatch = text.match(/\|\s*ages?\s*=\s*(\d+)\+/i)
    || text.match(/\bages?\s+(\d+)\+/i);
  if (ageMatch) result.ageRating = `${ageMatch[1]}+`;

  // Tags from skills field.
  const skillsMatch = text.match(/\|\s*skills\s*=\s*\{\{ubl\|([^}]+)\}\}/i);
  if (skillsMatch) {
    const skills = skillsMatch[1]
      .split("|")
      .map((s: string) => s.replace(/^\[\[|\]\]$/g, "").trim().toLowerCase())
      .filter(Boolean);
    if (skills.length > 0) result.tags = skills.slice(0, 5);
  }

  // Publisher name + website.
  const pubMatch = text.match(/\|\s*publisher\s*=\s*\[\[([^\]|]+)\|?/i)
    || text.match(/\|\s*publisher\s*=\s*([^\n|]+)/i);
  if (pubMatch) {
    const pubName = stripHtml(pubMatch[1]).trim();
    result.publisherName = pubName;

    // Follow the publisher's Wikipedia page to find their website.
    try {
      const pubRes = await safeFetch(
        `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pubName)}&prop=wikitext&redirects=1&format=json`,
        {
          headers: { "User-Agent": "BoardGameParlor/1.0 (self-hosted catalog)" },
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (pubRes.ok) {
        const pubData = await pubRes.json();
        const pubWt = pubData.parse?.wikitext;
        const pubText: string = typeof pubWt === "string" ? pubWt : (pubWt as any)?.["*"] ?? "";
        const siteMatch = pubText.match(/\|\s*website\s*=\s*\[\[?(https?:\/\/[^|\]]+)/i)
          || pubText.match(/\|\s*website\s*=\s*(https?:\/\/\S+)/i)
          || pubText.match(/\|\s*website\s*=\s*([a-z0-9.-]+\.[a-z]{2,})/i);
        if (siteMatch) {
          let url = siteMatch[1].trim();
          if (!url.startsWith("http")) url = `https://${url}`;
          result.publisherUrl = url;
        }
      }
    } catch {
      /* non-critical */
    }
  }

  return result;
}

// ─── Web Search Fallback (official sources only) ─────────────────────────────

/**
 * Domains that are known third-party aggregators, wikis, or forums.
 * We never accept results from these — only official publisher sites.
 */
const NON_OFFICIAL_DOMAINS = new Set([
  "boardgamegeek.com",
  "board-game-rules.com",
  "wikipedia.org",
  "wikihow.com",
  "quora.com",
  "reddit.com",
  "youtube.com",
  "facebook.com",
  "twitter.com",
  "medium.com",
  "boardsandbrews.com",
  "boardgamequarterly.com",
  "strategygames.com",
  "meeple.ca",
  "bsgreview.com",
  "boardgamereview.net",
]);

/**
 * Search the wider web for a game title. Only accepts results from
 * domains that appear to be official publisher sources. Returns the URL
 * so the user can verify before accepting.
 */
async function lookupWeb(name: string, publisher?: string | null): Promise<LookupResult | null> {
  const query = `${name} board game official rules`;
  const encoded = encodeURIComponent(query);

  try {
    let html: string;
    try {
      // Guarded fetch with a size cap: defense-in-depth even for the
      // hardcoded trusted DDG endpoint.
      html = await fetchTextWithLimit(`https://html.duckduckgo.com/html/?q=${encoded}`, MAX_HTML_SIZE, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (e instanceof SsrfBlockedError || e instanceof HtmlTooLargeError) {
        console.log(`lookup: DDG search skipped (${e.message})`);
      }
      return null; // skip gracefully on any fetch failure
    }

    // Collect candidate URLs from the search results.
    const candidates: string[] = [];

    // Direct links.
    for (const m of html.matchAll(/href="([^"]+)"[^>]*>/gi)) {
      const url = m[1];
      if (url.startsWith("http") && !candidates.includes(url) && !url.includes("duckduckgo.com")) {
        candidates.push(url);
      }
    }

    // DuckDuckGo redirect URLs.
    for (const m of html.matchAll(/uddg=([^&"]+)/gi)) {
      try {
        const decoded = decodeURIComponent(m[1]);
        if (decoded.startsWith("http") && !candidates.includes(decoded)) {
          candidates.push(decoded);
        }
      } catch { /* skip */ }
    }

    // Filter to only official publisher domains.
    const acceptableUrls: string[] = [];
    for (const url of candidates) {
      try {
        const parsed = new URL(url);
        const domain = parsed.hostname.replace(/^www\./, "");

        // Reject known non-official domains.
        if (NON_OFFICIAL_DOMAINS.has(domain)) continue;

        // If we have a publisher hint, prefer domains that match it.
        if (publisher) {
          const pubLower = publisher.toLowerCase();
          const domainLower = domain.toLowerCase();
          // Check if the domain contains any word from the publisher name.
          const pubWords = pubLower.split(/\s+/).filter((w) => w.length > 3);
          const matches = pubWords.some((w) => domainLower.includes(w));
          if (!matches) continue;
        }

        acceptableUrls.push(url);
      } catch { /* skip malformed */ }
    }

    if (acceptableUrls.length === 0) return null;

    // Fetch the first candidate that passes the SSRF guard and serves a page.
    // Candidate URLs come from search results (attacker-influenceable), so each
    // is fetched via safeFetch, which validates the host AND every redirect hop.
    // A URL blocked by the guard is skipped in favor of the next candidate.
    // Bounded to a few candidates so a run of dead/blocked links can't stall
    // the route (each attempt has its own 15s timeout budget).
    const result: LookupResult = { title: name, source: "web" };
    for (const url of acceptableUrls.slice(0, 3)) {
      let pageHtml: string;
      try {
        pageHtml = await fetchTextWithLimit(url, MAX_HTML_SIZE, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        if (e instanceof SsrfBlockedError) {
          console.log(`lookup: SSRF guard blocked ${url}, trying next candidate`);
        }
        continue; // skip this URL and try the next candidate
      }

      result.webUrl = url;

      try {
        // Title.
        const titleMatch = pageHtml.match(/<title[^>]*>\s*([^<]+?)\s*<\/title>/i);
        if (titleMatch) {
          const t = stripHtml(titleMatch[1]);
          if (t.length < 100 && !t.includes("404")) result.title = t;
        }

        // Description from meta tag.
        const descMatch = pageHtml.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
        if (descMatch) result.description = stripHtml(descMatch[1]).slice(0, 400);

        // Try to extract players/playtime from visible text.
        const textContent = pageHtml
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ");

        const playersMatch = textContent.match(/(\d+)\s*[-–]\s*(\d+)\s*players/i)
          || textContent.match(/for\s+(\d+)\s*players/i);
        if (playersMatch) {
          result.players = playersMatch[2] ? `${playersMatch[1]}-${playersMatch[2]}` : playersMatch[1];
        }

        const timeMatch = textContent.match(/(\d+)\s*minutes?/i);
        if (timeMatch) result.playtimeMinutes = Number(timeMatch[1]);
      } catch { /* non-critical — return what we have */ }

      break; // got a usable page — done.
    }

    return result.webUrl ? result : null;
  } catch {
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
