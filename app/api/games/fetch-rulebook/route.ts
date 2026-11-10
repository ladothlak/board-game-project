import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import {
  decodeHtmlEntities,
  resolveFileShareUrl,
  isValidPdf,
  isUrlForBaseGame,
  detectLanguage,
  isLanguageCompatible,
  LANG_2_TO_3,
  UA,
  MAX_PDF_SIZE,
  PdfTooLargeError,
  readWithSizeLimit,
  isSafeUrl,
  safeFetch,
  SsrfBlockedError,
  fetchTextWithLimit,
  MAX_HTML_SIZE,
} from "@/lib/fetch-rulebook-utils";

/**
 * Best-effort rulebook PDF fetch. Codified search routine with learning:
 *
 * Strategy 1: Known URLs (persistent cache + static dict + publisher patterns).
 *   - Instant hit for previously found games.
 *   - Predictable patterns (Hasbro, etc.).
 *
 * Strategy 2: Publisher base URL probe (learned over time).
 *   - If we've learned a publisher's directory structure, try common
 *     filename patterns under that base URL.
 *   - e.g., learned "awakenrealms.com/images/download/" → try
 *     "<base>/<Game>/ENG/rulebook.pdf", etc.
 *
 * Strategy 3: Targeted web search (scoped to known domain if available).
 *   - If we know the publisher's domain, search `site:<domain> <game> pdf`.
 *   - Otherwise, generic `<game> rulebook PDF download`.
 *   - Decodes DuckDuckGo redirect URLs (uddg= parameter).
 *
 * Strategy 4: Publisher site scan (if publisher URL available).
 *   - Fetches the site, looks for PDF links in HTML.
 *
 * Learning: When a rulebook is found via Strategies 2-4, the URL is persisted
 * to content/known-rulebooks.json. If a publisher name is available, the
 * base URL is also learned so future games from that publisher benefit.
 */

// ─── Static Known URL Patterns ───────────────────────────────────────────────
// Predictable URL patterns by publisher (hardcoded, always available).

// Known name aliases for publishers (game name → alternate filenames).
const NAME_ALIASES: Record<string, string[]> = {
  clue: ["cluedo", "clue"],
  monopoly: ["monopoly", "monopoly-deluxe"],
  risk: ["risk", "risk-classic"],
  stratego: ["stratego", "strat-o-ged"],
  "clue junior": ["clue-junior", "cluedo-junior"],
};

const PUBLISHER_PATTERNS: Record<string, (name: string) => string[]> = {
  hasbro: (name) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const slugUnderscore = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const candidates = [
      `https://www.hasbro.com/common/instruct/${slug}.pdf`,
      `https://www.hasbro.com/common/instruct/${slugUnderscore}.pdf`,
      `https://www.hasbro.com/common/instruct/${name.toLowerCase()}.pdf`,
    ];
    // Add alias variants.
    const aliases = NAME_ALIASES[name.toLowerCase().trim()];
    if (aliases) {
      for (const alias of aliases) {
        candidates.push(`https://www.hasbro.com/common/instruct/${alias}.pdf`);
      }
    }
    return candidates;
  },
};

/**
 * Static known rulebook URLs for games where the filename isn't predictable.
 * Key: lowercase game name (normalized). Fallback for when JSON file is missing.
 */
const KNOWN_RULEBOOK_URLS: Record<string, string> = {
  "nemesis lockdown":
    "https://awakenrealms.com/images/download/Nemesis_Lockdown/ENG/Nemesis_LD_Rulebook_280x280mm_bleed3mm-32-pages.pdf",
};

// ─── Persistent Cache (games + publishers) ────────────────────────────────────

interface PublisherInfo {
  baseUrl: string;
  domain: string;
}

interface KnownRulebooksData {
  games: Record<string, string>;
  publishers: Record<string, PublisherInfo>;
}

const KNOWN_RULEBOOKS_FILE = path.join(process.cwd(), "content", "known-rulebooks.json");

async function loadKnownRulebooks(): Promise<KnownRulebooksData> {
  try {
    const raw = await readFile(KNOWN_RULEBOOKS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return {
      games: data.games ?? {},
      publishers: data.publishers ?? {},
    };
  } catch {
    /* corrupted or missing — start fresh */
  }
  return { games: {}, publishers: {} };
}

async function saveKnownRulebooks(data: KnownRulebooksData): Promise<void> {
  try {
    await writeFile(KNOWN_RULEBOOKS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch {
    /* non-critical */
  }
}

/**
 * Persist a found rulebook URL and learn the publisher's base URL.
 * Called after Strategies 2-4 succeed.
 */
async function persistFinding(gameName: string, url: string, publisherName?: string): Promise<void> {
  const data = await loadKnownRulebooks();

  // Store the game → URL mapping.
  data.games[normalizeName(gameName)] = url;

  // Learn the publisher's base URL from the found URL.
  if (publisherName) {
    try {
      const parsed = new URL(url);
      // Extract the base path: origin + directory containing the game folder.
      // e.g., https://awakenrealms.com/images/download/Nemesis_Lockdown/ENG/file.pdf
      // → baseUrl = https://awakenrealms.com/images/download/
      const parts = parsed.pathname.split("/").filter(Boolean);
      // The game folder is typically the first meaningful path segment after the base.
      // Heuristic: take origin + first two path segments as the base.
      let basePath = "";
      if (parts.length >= 3) {
        // e.g., ["images", "download", "Nemesis_Lockdown", "ENG", "file.pdf"]
        // base = /images/download/
        basePath = "/" + parts.slice(0, 2).join("/") + "/";
      } else if (parts.length === 2) {
        // e.g., ["common", "instruct", "monopoly.pdf"] → /common/instruct/
        basePath = "/" + parts.slice(0, 2).join("/") + "/";
      }

      const baseUrl = `${parsed.origin}${basePath}`;
      const pubKey = normalizeName(publisherName);
      data.publishers[pubKey] = {
        baseUrl,
        domain: parsed.hostname,
      };
    } catch {
      /* can't parse URL — skip publisher learning */
    }
  }

  await saveKnownRulebooks(data);
}

/** Normalize a name for use as a JSON key. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[:\s-]+/g, " ").trim();
}

// ─── Strategy 1: Known URLs ───────────────────────────────────────────────────

async function tryKnownUrls(gameName: string, excluded: Set<string>, isExpansion = false, language?: string): Promise<string | null> {
  const normalized = normalizeName(gameName);
  const data = await loadKnownRulebooks();
  const check = (url: string) => (isExpansion || isUrlForBaseGame(url, gameName)) && isLanguageCompatible(url, language);

  // 1. Persistent cache (accumulated over time).
  const cachedUrl = data.games[normalized];
  if (cachedUrl && !excluded.has(cachedUrl)) {
    if (check(cachedUrl) && await isValidPdf(cachedUrl)) return cachedUrl;
  }

  // 2. Static known URLs dict.
  const directUrl = KNOWN_RULEBOOK_URLS[normalized];
  if (directUrl && !excluded.has(directUrl)) {
    if (check(directUrl) && await isValidPdf(directUrl)) return directUrl;
  }

  // 3. Publisher patterns (Hasbro, etc.).
  for (const fn of Object.values(PUBLISHER_PATTERNS)) {
    const candidates = fn(gameName);
    for (const url of candidates) {
      if (excluded.has(url)) continue;
      if (!check(url)) continue;
      if (await isValidPdf(url)) return url;
    }
  }

  return null;
}

// ─── Strategy 2: Publisher Base URL Probe ─────────────────────────────────────

/**
 * If we've learned a publisher's base URL, try common filename patterns
 * under that directory structure. This is much faster than a web search.
 */
async function probePublisherBase(gameName: string, publisherName?: string, excluded?: Set<string>, isExpansion = false, language?: string): Promise<string | null> {
  const data = await loadKnownRulebooks();
  if (!publisherName) return null;

  const pubKey = normalizeName(publisherName);
  const pubInfo = data.publishers[pubKey];
  if (!pubInfo) return null;

  // Build candidate URLs using the learned base URL.
  // Publisher sites use 3-letter ISO folder codes (e.g., /ENG/), not 2-letter ones.
  const langCode = (language ?? "en").toLowerCase();
  const langFolder = LANG_2_TO_3[langCode] ?? langCode.toUpperCase();
  const gameFolder = gameName.replace(/[:\s]+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
  const slug = gameName.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const candidates: string[] = [
    `${pubInfo.baseUrl}${gameFolder}/${langFolder}/rulebook.pdf`,
    `${pubInfo.baseUrl}${gameFolder}/${langFolder}/${gameFolder}_RULEBOOK.pdf`,
    `${pubInfo.baseUrl}${gameFolder}/${langFolder}/${slug}_rulebook.pdf`,
    `${pubInfo.baseUrl}${gameFolder}/${langFolder}/${gameFolder}_Rulebook.pdf`,
    `${pubInfo.baseUrl}${gameFolder}/rulebook.pdf`,
    `${pubInfo.baseUrl}${gameFolder}/rules.pdf`,
  ];

  const check = (url: string) => (isExpansion || isUrlForBaseGame(url, gameName)) && isLanguageCompatible(url, language);
  for (const url of candidates) {
    if (excluded?.has(url)) continue;
    if (!check(url)) continue;
    if (await isValidPdf(url)) return url;
  }
  return null;
}

// ─── Strategy 3: Targeted Web Search ──────────────────────────────────────────

/**
 * Search the web for a rulebook PDF using Brave Search API.
 * If we know the publisher's domain, scope the search to that domain.
 * Also follows top results to find PDF links on publisher pages.
 */
async function webSearchForPdf(gameName: string, publisherName?: string, excluded?: Set<string>, isExpansion = false, language?: string): Promise<string | null> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return null; // No API key configured — skip strategy.

  // Build the search query.
  let query: string;
  const data = await loadKnownRulebooks();
  const pubKey = publisherName ? normalizeName(publisherName) : null;
  const pubInfo = pubKey ? data.publishers[pubKey] : null;

  // Language hint for search (helps surface the right edition).
  const langHint = language ? ` ${language.toUpperCase()} rulebook` : " rulebook";

  if (pubInfo?.domain) {
    // Targeted: search within the known domain.
    query = `site:${pubInfo.domain} ${gameName}${langHint} pdf`;
  } else {
    // Generic: broad search.
    query = isExpansion
      ? `${gameName} expansion${langHint} PDF download`
      : `${gameName} board game${langHint} PDF download`;
  }

  const candidates: string[] = [];

  try {
    // Call Brave Search API.
    const searchRes = await safeFetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`,
      {
        headers: {
          "X-Subscription-Token": apiKey,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();

    const results: Array<{ url: string; title?: string; description?: string }> = searchData?.web?.results ?? [];

    // 1. Collect direct .pdf URLs from results.
    for (const r of results) {
      if (/\.pdf/i.test(r.url) && !candidates.includes(r.url)) {
        candidates.push(r.url);
      }
    }

    // 2. Follow top non-PDF results (publisher pages) to find PDF links.
    for (const r of results.slice(0, 5)) {
      if (/\.pdf/i.test(r.url)) continue; // Already collected above.
      if (excluded?.has(r.url)) continue;

      // Fetch the page and look for PDF links.
      try {
        const html = await fetchTextWithLimit(r.url, MAX_HTML_SIZE, {
          headers: { "User-Agent": UA, "Accept": "text/html" },
          signal: AbortSignal.timeout(10_000),
        });

        // Extract .pdf links from the page.
        for (const m of html.matchAll(/href=["']([^"']*\.pdf[^"']*)["']/gi)) {
          const pdfUrl = decodeHtmlEntities(m[1].startsWith("http") ? m[1] : new URL(m[1], r.url).toString());
          if (!candidates.includes(pdfUrl) && !excluded?.has(pdfUrl)) {
            candidates.push(pdfUrl);
          }
        }

        // Also check for Dropbox/Drive direct download patterns.
        for (const m of html.matchAll(/href=["']([^"']*(?:dropbox|drive\.google)[^"']*)["']/gi)) {
          const fileUrl = decodeHtmlEntities(m[1].startsWith("http") ? m[1] : new URL(m[1], r.url).toString());
          if (!candidates.includes(fileUrl) && !excluded?.has(fileUrl)) {
            candidates.push(fileUrl);
          }
        }
      } catch {
        /* skip unreachable page */
      }
    }
  } catch {
    /* non-critical */
  }

  // Try each candidate (up to 10) with a HEAD request.
  const check = (url: string) => (isExpansion || isUrlForBaseGame(url, gameName)) && isLanguageCompatible(url, language);
  for (const url of candidates.slice(0, 10)) {
    if (excluded?.has(url)) continue;
    if (!check(url)) continue;
    if (await isValidPdf(url)) return url;
  }

  return null;
}

// ─── Strategy 4: Scan Publisher Site ──────────────────────────────────────────

const PDF_LINK_PATTERNS = [
  /href="([^"]*\.pdf[^"]*)"[^>]*>[^<]*(rule|rules|manual|guide|book)/i,
  /href="([^"]*\.pdf[^"]*)"[^>]*class="[^"]*(download|file|attachment)/i,
  /href="([^"]*rule[^"]*\.pdf[^"]*)"/i,
  /href="([^"]*rules?[^"]*\.pdf[^"]*)"/i,
  /href="([^"]*manual[^"]*\.pdf[^"]*)"/i,
  /href="([^"]*guide[^"]*\.pdf[^"]*)"/i,
];

async function scanPublisherSite(publisherUrl: string, gameName?: string, excluded?: Set<string>, isExpansion = false, language?: string): Promise<string | null> {
  const check = (url: string) => (isExpansion || isUrlForBaseGame(url, gameName ?? "")) && isLanguageCompatible(url, language);
  try {
    const html = await fetchTextWithLimit(publisherUrl, MAX_HTML_SIZE, {
      headers: { "User-Agent": UA, "Accept": "text/html" },
      signal: AbortSignal.timeout(20_000),
    });

    // 1. Scan for rulebook PDF links directly on the page.
    for (const pattern of PDF_LINK_PATTERNS) {
      const match = html.match(pattern);
      if (match?.[1]) {
        try {
          const resolved = new URL(match[1], publisherUrl).toString();
          if (!excluded?.has(resolved) && check(resolved) && await isValidPdf(resolved)) return resolved;
        } catch {
          if (!excluded?.has(match[1]) && check(match[1]) && await isValidPdf(match[1])) return match[1];
        }
      }
    }

    // 2. Follow one level of links: look for "rules", "downloads", "files" pages.
    const subPageUrls: string[] = [];
    for (const m of html.matchAll(/href=["']([^"']*(?:rule|download|file|manual|guide)[^"']*)["'][^>]*>([^<]{0,40}(?:rule|download|file|manual|guide)[^<]{0,40})/gi)) {
      const href = m[1];
      if (href.startsWith("http") && !href.includes(".pdf")) {
        subPageUrls.push(new URL(href, publisherUrl).toString());
      } else if (!href.startsWith("http") && !href.startsWith("#") && !href.includes(".pdf")) {
        subPageUrls.push(new URL(href, publisherUrl).toString());
      }
    }

    // Also try common game-specific paths.
    if (gameName) {
      const origin = new URL(publisherUrl).origin;
      const slug = gameName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      subPageUrls.push(
        `${origin}/games/${slug}/rules`,
        `${origin}/${slug}/rules`,
        `${origin}/games/${slug}/downloads`,
      );
    }

    // Check up to 3 sub-pages for PDF links.
    for (const subUrl of subPageUrls.slice(0, 3)) {
      if (excluded?.has(subUrl)) continue;
      try {
        const subHtml = await fetchTextWithLimit(subUrl, MAX_HTML_SIZE, {
          headers: { "User-Agent": UA, "Accept": "text/html" },
          signal: AbortSignal.timeout(10_000),
        });

        // Look for PDF links on the sub-page.
        for (const m of subHtml.matchAll(/href=["']([^"']*\.pdf[^"']*)["']/gi)) {
          const pdfUrl = m[1].startsWith("http") ? m[1] : new URL(m[1], subUrl).toString();
          if (!excluded?.has(pdfUrl) && check(pdfUrl) && await isValidPdf(pdfUrl)) return pdfUrl;
        }

        // Also check for Dropbox/Drive links.
        for (const m of subHtml.matchAll(/href=["']([^"']*(?:dropbox|drive\.google)[^"']*)["']/gi)) {
          const fileUrl = m[1].startsWith("http") ? m[1] : new URL(m[1], subUrl).toString();
          if (!excluded?.has(fileUrl) && check(fileUrl) && await isValidPdf(fileUrl)) return fileUrl;
        }
      } catch {
        /* skip unreachable */
      }
    }

    // 3. Try common direct paths on the publisher's domain.
    if (gameName) {
      const origin = new URL(publisherUrl).origin;
      const slug = gameName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const candidates = [
        `${origin}/rules/${slug}.pdf`,
        `${origin}/downloads/${slug}.pdf`,
        `${origin}/files/${slug}-rules.pdf`,
        `${origin}/rulebooks/${slug}.pdf`,
        `${origin}/assets/${slug}-rulebook.pdf`,
      ];
      for (const candidate of candidates) {
        if (excluded?.has(candidate)) continue;
        if (!check(candidate)) continue;
        if (await isValidPdf(candidate)) return candidate;
      }
    }
  } catch {
    /* non-critical */
  }
  return null;
}

// ─── Auto-Lookup Publisher ─────────────────────────────────────────────────────

/**
 * Lightweight publisher lookup via Wikipedia. If the game has a Wikipedia
 * article, extract the publisher name and website from the infobox.
 * Returns null if no publisher info is found.
 */
async function autoLookupPublisher(gameName: string): Promise<{ publisherUrl?: string; publisherName?: string } | null> {
  try {
    // 1. Find the article via opensearch.
    const searchRes = await safeFetch(
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(gameName + " board game")}&limit=3&format=json`,
      { headers: { "User-Agent": "BoardGameParlor/1.0 (self-hosted catalog)" }, signal: AbortSignal.timeout(8_000) }
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const titles: string[] = searchData[1] ?? [];
    if (titles.length === 0) return null;

    // 2. Parse the article's wikitext for publisher info.
    const articleTitle = titles[0];
    const parseRes = await safeFetch(
      `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(articleTitle)}&prop=wikitext&redirects=1&format=json`,
      { headers: { "User-Agent": "BoardGameParlor/1.0 (self-hosted catalog)" }, signal: AbortSignal.timeout(8_000) }
    );
    if (!parseRes.ok) return null;
    const parseData = await parseRes.json();
    const wt = parseData.parse?.wikitext;
    const text = typeof wt === "string" ? wt : (wt as any)?.["*"] ?? "";

    // 3. Extract publisher name from infobox.
    const pubMatch = text.match(/\|\s*(?:publisher|published_by)\s*=\s*(.+?)(?:\n\s*\||\n\n|$)/i);
    const publisherName = pubMatch?.[1]?.trim() || null;

    // 4. Extract website from infobox.
    const webMatch = text.match(/\|\s*website\s*=\s*\[?\s*(https?:\/\/\S+)/i);
    const publisherUrl = webMatch?.[1]?.replace(/\]\]/, "").trim() || null;

    if (publisherName || publisherUrl) {
      return { publisherName, publisherUrl };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const start = Date.now();
  const ip = getClientIp(req);

  // Rate limit: 5 per minute (accommodates dismiss-and-retry flow).
  const rate = checkRate(ip, "/api/games/fetch-rulebook", 5, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 429, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Too many fetch attempts — wait a minute." }, { status: 429 });
  }

  let body: { publisherUrl?: string | null; gameName?: string; publisherName?: string; excludeUrls?: string[]; directUrl?: string; isExpansion?: boolean; language?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { publisherUrl: bodyPublisherUrl, gameName, publisherName: bodyPublisherName, excludeUrls, directUrl, isExpansion, language } = body;
  const excluded = new Set(excludeUrls ?? []);
  if (!gameName && !bodyPublisherUrl && !directUrl) {
    return NextResponse.json({ error: "Game name, publisher URL, or direct URL is required" }, { status: 400 });
  }

  // SSRF guard: reject user-supplied URLs that resolve to a private/internal
  // address (cloud metadata 169.254.x.x, RFC1918 ranges, non-localhost loopback).
  // Fail fast with a clear 403 before any server-side fetch is attempted.
  for (const u of [directUrl, bodyPublisherUrl]) {
    if (u && !(await isSafeUrl(u))) {
      logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 403, durationMs: Date.now() - start });
      return NextResponse.json(
        { error: "Blocked: that URL points to a private or internal address." },
        { status: 403 }
      );
    }
  }

  // Auto-lookup: if we have a game name but no publisher info, try to find it.
  let publisherUrl = bodyPublisherUrl;
  let publisherName = bodyPublisherName;
  if (gameName && !publisherUrl && !publisherName) {
    const lookup = await autoLookupPublisher(gameName);
    if (lookup) {
      publisherUrl = lookup.publisherUrl;
      publisherName = lookup.publisherName;
    }
  }

  try {
    let pdfUrl: string | null = null;
    let foundVia = "";

    // Direct URL: skip all strategies, download from the given URL.
    if (directUrl) {
      if (await isValidPdf(directUrl)) {
        pdfUrl = directUrl;
        foundVia = "direct";
      }
    }

    // Strategy 1: Known URLs (cache + static + patterns).
    if (!pdfUrl && gameName) {
      pdfUrl = await tryKnownUrls(gameName, excluded, isExpansion, language);
      if (pdfUrl) foundVia = "known";
    }

    // Strategy 2: Publisher base URL probe (learned structure).
    if (!pdfUrl && gameName && publisherName) {
      pdfUrl = await probePublisherBase(gameName, publisherName, excluded, isExpansion, language);
      if (pdfUrl) foundVia = "probe";
    }

    // Strategy 3: Targeted web search.
    if (!pdfUrl && gameName) {
      pdfUrl = await webSearchForPdf(gameName, publisherName, excluded, isExpansion, language);
      if (pdfUrl) foundVia = "search";
    }

    // Strategy 4: Publisher site scan.
    if (!pdfUrl && publisherUrl && gameName) {
      pdfUrl = await scanPublisherSite(publisherUrl, gameName, excluded, isExpansion, language);
      if (pdfUrl) foundVia = "scan";
    }

    if (!pdfUrl) {
      logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 404, durationMs: Date.now() - start });
      return NextResponse.json(
        { error: "No rulebook PDF found automatically. Drag your copy in instead." },
        { status: 404 }
      );
    }

    // Persist the finding (learn for future requests).
    if (gameName && foundVia !== "known") {
      await persistFinding(gameName, pdfUrl, publisherName);
    }

    // Download the PDF.
    const downloadUrl = decodeHtmlEntities(resolveFileShareUrl(pdfUrl) ?? pdfUrl);
    const pdfRes = await safeFetch(downloadUrl, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(120_000),
    });
    if (!pdfRes.ok) {
      throw new Error(`PDF download returned ${pdfRes.status}`);
    }

    const contentType = pdfRes.headers.get("content-type") ?? "";
    // Accept PDF content-types OR URLs that end in .pdf.
    // Dropbox/Drive serve files as application/binary, so we can't rely on content-type alone.
    const looksLikePdf = contentType.includes("pdf") || pdfUrl.endsWith(".pdf") || contentType.includes("binary") || contentType.includes("octet-stream");
    if (!looksLikePdf) {
      throw new Error("Found a link but it isn't a PDF file.");
    }

    const bytes = await readWithSizeLimit(pdfRes, MAX_PDF_SIZE);

    // Sanity check: PDFs start with %PDF.
    if (bytes.subarray(0, 4).toString() !== "%PDF") {
      throw new Error("Downloaded file doesn't look like a valid PDF.");
    }

    logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 200, durationMs: Date.now() - start });
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "X-Pdf-Url": pdfUrl,
        "X-Found-Via": foundVia,
      },
    });
  } catch (e) {
    if (e instanceof SsrfBlockedError) {
      logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 403, durationMs: Date.now() - start });
      return NextResponse.json(
        { error: "Blocked: that URL points to a private or internal address." },
        { status: 403 }
      );
    }
    if (e instanceof PdfTooLargeError) {
      logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 413, durationMs: Date.now() - start });
      return NextResponse.json(
        { error: `The rulebook PDF is too large to download (${e.message}). Drag your copy in instead.` },
        { status: 413 }
      );
    }
    logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 502, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: `Couldn't fetch the rulebook automatically (${e instanceof Error ? e.message : "unknown error"}). Drag your copy in instead.` },
      { status: 502 }
    );
  }
}
