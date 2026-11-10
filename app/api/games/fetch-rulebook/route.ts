import { NextResponse } from "next/server";
import { checkRate } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

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

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

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

function loadKnownRulebooks(): KnownRulebooksData {
  try {
    if (existsSync(KNOWN_RULEBOOKS_FILE)) {
      const raw = readFileSync(KNOWN_RULEBOOKS_FILE, "utf-8");
      const data = JSON.parse(raw);
      return {
        games: data.games ?? {},
        publishers: data.publishers ?? {},
      };
    }
  } catch {
    /* corrupted or missing — start fresh */
  }
  return { games: {}, publishers: {} };
}

function saveKnownRulebooks(data: KnownRulebooksData): void {
  try {
    writeFileSync(KNOWN_RULEBOOKS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch {
    /* non-critical */
  }
}

/**
 * Persist a found rulebook URL and learn the publisher's base URL.
 * Called after Strategies 2-4 succeed.
 */
function persistFinding(gameName: string, url: string, publisherName?: string): void {
  const data = loadKnownRulebooks();

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

  saveKnownRulebooks(data);
}

/** Normalize a name for use as a JSON key. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[:\s-]+/g, " ").trim();
}

// ─── Strategy 1: Known URLs ───────────────────────────────────────────────────

async function tryKnownUrls(gameName: string, excluded: Set<string>, isExpansion = false, language?: string): Promise<string | null> {
  const normalized = normalizeName(gameName);
  const data = loadKnownRulebooks();
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
  const data = loadKnownRulebooks();
  if (!publisherName) return null;

  const pubKey = normalizeName(publisherName);
  const pubInfo = data.publishers[pubKey];
  if (!pubInfo) return null;

  // Build candidate URLs using the learned base URL.
  const langFolder = (language ?? "en").toUpperCase();
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
  const data = loadKnownRulebooks();
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
    const searchRes = await fetch(
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
        const pageRes = await fetch(r.url, {
          headers: { "User-Agent": UA, "Accept": "text/html" },
          signal: AbortSignal.timeout(10_000),
          redirect: "follow",
        });
        if (!pageRes.ok) continue;
        const html = await pageRes.text();

        // Extract .pdf links from the page.
        for (const m of html.matchAll(/href=["']([^"']*\.pdf[^"']*)["']/gi)) {
          const pdfUrl = m[1].startsWith("http") ? m[1] : new URL(m[1], r.url).toString();
          if (!candidates.includes(pdfUrl) && !excluded?.has(pdfUrl)) {
            candidates.push(pdfUrl);
          }
        }

        // Also check for Dropbox/Drive direct download patterns.
        for (const m of html.matchAll(/href=["']([^"']*(?:dropbox|drive\.google)[^"']*)["']/gi)) {
          const fileUrl = m[1].startsWith("http") ? m[1] : new URL(m[1], r.url).toString();
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
    const homeRes = await fetch(publisherUrl, {
      headers: { "User-Agent": UA, "Accept": "text/html" },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (!homeRes.ok) return null;
    const html = await homeRes.text();

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
        const subRes = await fetch(subUrl, {
          headers: { "User-Agent": UA, "Accept": "text/html" },
          signal: AbortSignal.timeout(10_000),
          redirect: "follow",
        });
        if (!subRes.ok) continue;
        const subHtml = await subRes.text();

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

// ─── File Share URL Resolver ──────────────────────────────────────────────────

/**
 * Resolve Dropbox/Google Drive share links to direct download URLs.
 * Returns the resolved URL or null if it's not a recognized file-share pattern.
 */
function resolveFileShareUrl(url: string): string | null {
  try {
    const parsed = new URL(url);

    // Dropbox: dropbox.com/scl/fo/<id>/<token>?dl=0 → dl.dropboxusercontent.com/scl/fo/<id>/<token>?rlkey=<key>&st=<st>
    // Actually, the direct download is: https://dl.dropboxusercontent.com/scl/fo/<same-path>?rlkey=<key>&st=<st>&dl=1
    // Simpler: just append ?dl=1 to force download.
    if (parsed.hostname.includes("dropbox.com") && parsed.pathname.startsWith("/scl/")) {
      // Convert to direct download by ensuring dl=1 parameter.
      const searchParams = new URLSearchParams(parsed.search);
      searchParams.set("dl", "1");
      return `${parsed.origin}${parsed.pathname}?${searchParams.toString()}`;
    }

    // Google Drive: drive.google.com/file/d/<fileId>/view → drive.google.com/uc?export=download&id=<fileId>
    if (parsed.hostname === "drive.google.com" && parsed.pathname.startsWith("/file/d/")) {
      const fileId = parsed.pathname.split("/")[4];
      if (fileId) {
        return `https://drive.google.com/uc?export=download&id=${fileId}`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Shared Helper ────────────────────────────────────────────────────────────

/**
 * Check if a URL serves a valid PDF (HEAD request, content-type check).
 * Requires the server to actually report PDF content-type — not just a .pdf extension.
 * Also resolves Dropbox/Drive share links before checking.
 */
async function isValidPdf(url: string): Promise<boolean> {
  try {
    // Resolve file-share URLs (Dropbox, Drive) to direct download links.
    const resolved = resolveFileShareUrl(url) ?? url;
    const res = await fetch(resolved, {
      method: "HEAD",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res.ok) return false;
    const ct = res.headers.get("content-type") ?? "";
    // Must explicitly serve as a PDF. Some servers return 200 + HTML for missing files.
    return ct.includes("pdf");
  } catch {
    return false;
  }
}

/**
 * Check if a URL appears to be for the *base* game, not an expansion or sequel.
 *
 * Heuristic: extract the path segment(s) from the URL that contain the game name.
 * If the segment is exactly the game name (normalized), check the filename.
 * If the filename contains the game name followed by additional words
 * (e.g., "NEMESIS_VOIDSEEDERS_RULEBOOK"), it's an expansion and should be rejected.
 *
 * Examples for gameName = "Nemesis":
 *   ✓ https://.../Nemesis/ENG/rulebook.pdf                    → folder "Nemesis", file "rulebook.pdf" (base)
 *   ✗ https://.../Nemesis/IT/NEMESIS_VOIDSEEDERS_RULEBOOK.pdf → file contains "VOIDSEEDERS" (expansion)
 *   ✗ https://.../Nemesis_Lockdown/ENG/...                     → folder "Nemesis_Lockdown" (expansion)
 */
function isUrlForBaseGame(url: string, gameName: string): boolean {
  const normalized = gameName.toLowerCase().replace(/[:\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");

  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split("/").filter(Boolean);

    // Find the segment that contains the normalized game name.
    let foundSegment = false;
    for (const segment of pathSegments) {
      const segLower = segment.toLowerCase();
      if (segLower.includes(normalized)) {
        foundSegment = true;
        // Check if the segment is *exactly* the game name (allowing .pdf extension).
        const segNoExt = segLower.replace(/\.pdf$/i, "");
        if (segNoExt === normalized) {
          // Segment matches exactly — now check the filename for expansion indicators.
          break;
        }
        // Name variant: segment starts with the game name + a short suffix (≤ 3 chars).
        // e.g., "clue" → "cluedo", "risk" → "riskclassic". These are regional
        // name variants, not expansions.
        if (segNoExt.startsWith(normalized) && segNoExt.length - normalized.length <= 3) {
          break;
        }
        // The segment contains the game name plus extra words → expansion folder.
        // e.g., "nemesis_voidseeders" or "nemesis_lockdown".
        return false;
      }
    }

    if (!foundSegment) {
      // No path segment contains the game name — check the filename directly.
      const filename = pathSegments[pathSegments.length - 1]?.toLowerCase() ?? "";
      const fileNoExt = filename.replace(/\.pdf$/i, "");
      if (fileNoExt === normalized) return true;
      // If the filename starts with the game name followed by extra words → expansion.
      if (fileNoExt.startsWith(normalized + "_") || fileNoExt.startsWith(normalized + " ")) {
        return false;
      }
      // If the filename doesn't contain the game name at all, reject it —
      // it's likely a different game's rulebook (e.g. "rulebook.pdf" under
      // a sibling game's folder).
      if (!fileNoExt.includes(normalized)) return false;
      return true;
    }

    // A segment matched exactly. Now check the filename for expansion indicators.
    const filename = pathSegments[pathSegments.length - 1]?.toLowerCase() ?? "";
    const fileNoExt = filename.replace(/\.pdf$/i, "");

    // If the filename contains the game name followed by additional words, it's an expansion.
    // e.g., "nemesis_voidseeders_rulebook_280x280mm_it.pdf"
    if (fileNoExt.startsWith(normalized + "_") || fileNoExt.startsWith(normalized + " ")) {
      return false;
    }

    // Generic rulebook filenames are fine: "rulebook.pdf", "rules.pdf", "nemesis.pdf"
    return true;
  } catch {
    return true; // Can't parse URL — allow it.
  }
}

// ─── Language Detection ────────────────────────────────────────────────────────

const LANG_CODES = new Set(["en", "it", "de", "fr", "es", "pt", "nl", "sv", "no", "da", "fi", "pl", "cs", "hu", "ro", "tr", "ja", "ko", "zh"]);

// 3-letter ISO codes → 2-letter equivalent (for standalone path segments like /ENG/).
const LANG_3_TO_2: Record<string, string> = {
  eng: "en", ger: "de", fre: "fr", ita: "it", spa: "es", por: "pt",
  dut: "nl", swe: "sv", nor: "no", dan: "da", fin: "fi", pol: "pl",
  cze: "cs", hun: "hu", rum: "ro", tur: "tr", jpn: "ja", kor: "ko", chi: "zh",
};

// Generic words that commonly follow a language prefix in filenames.
const GENERIC_DESCRIPTORS = new Set(["rulebook", "rules", "manual", "instructions", "guide", "pdf", "game", "board", "edition"]);

/**
 * Detect the language of a rulebook URL by looking for ISO codes
 * in safe positions only. Returns the detected language code (lowercase)
 * or null if no language tag is found.
 *
 * Detection rules (designed to avoid false positives):
 * 1. Standalone path segment that is exactly a 2- or 3-letter code → definite.
 *    e.g., /ENG/, /DE/, /IT/
 * 2. Filename: last token before .pdf that is a 2-letter code → definite.
 *    e.g., rulebook_IT.pdf, rules-de.pdf
 * 3. Filename: first token is a 2-letter code AND the second token is a
 *    generic descriptor → probable.
 *    e.g., EN_rulebook.pdf, DE_manual.pdf
 * 4. Any other position → ambiguous, do NOT flag (avoids false positives
 *    like IT_LIVES.pdf being read as Italian "Lives").
 */
function detectLanguage(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split("/").filter(Boolean);

    // 1. Check path segments for a standalone 2- or 3-letter code.
    for (const segment of pathSegments) {
      const segLower = segment.toLowerCase();
      if (segLower.length === 2 && LANG_CODES.has(segLower)) {
        return segLower;
      }
      if (segLower.length === 3 && LANG_3_TO_2[segLower]) {
        return LANG_3_TO_2[segLower];
      }
    }

    // 2 & 3. Check filename tokens.
    const filename = pathSegments[pathSegments.length - 1]?.toLowerCase() ?? "";
    const fileNoExt = filename.replace(/\.pdf$/i, "");
    const tokens = fileNoExt.split(/[_\-.]/).filter(Boolean);

    if (tokens.length >= 2) {
      // Last token before extension: e.g., rulebook_IT → ["rulebook", "it"]
      const last = tokens[tokens.length - 1];
      if (last.length === 2 && LANG_CODES.has(last)) {
        return last;
      }
      // First token is a code AND second is generic: e.g., EN_rulebook → ["en", "rulebook"]
      const first = tokens[0];
      const second = tokens[1];
      if (first.length === 2 && LANG_CODES.has(first) && GENERIC_DESCRIPTORS.has(second)) {
        return first;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a URL's detected language is compatible with the desired language.
 * Returns true if:
 *   - No language is specified (no constraint), OR
 *   - No language tag is found in the URL (can't determine → allow), OR
 *   - The detected language matches the desired language.
 * Returns false if a language tag is found and it does NOT match.
 */
function isLanguageCompatible(url: string, desired?: string): boolean {
  if (!desired) return true;
  const detected = detectLanguage(url);
  if (!detected) return true; // No tag found — can't determine, allow it.
  return detected === desired.toLowerCase();
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
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(gameName + " board game")}&limit=3&format=json`,
      { headers: { "User-Agent": "BoardGameParlor/1.0 (self-hosted catalog)" }, signal: AbortSignal.timeout(8_000) }
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const titles: string[] = searchData[1] ?? [];
    if (titles.length === 0) return null;

    // 2. Parse the article's wikitext for publisher info.
    const articleTitle = titles[0];
    const parseRes = await fetch(
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
  const start = Date.now();
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";

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
      persistFinding(gameName, pdfUrl, publisherName);
    }

    // Download the PDF.
    const pdfRes = await fetch(pdfUrl, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(120_000),
      redirect: "follow",
    });
    if (!pdfRes.ok) {
      throw new Error(`PDF download returned ${pdfRes.status}`);
    }

    const contentType = pdfRes.headers.get("content-type") ?? "";
    if (!contentType.includes("pdf") && !pdfUrl.endsWith(".pdf")) {
      throw new Error("Found a link but it isn't a PDF file.");
    }

    const bytes = Buffer.from(await pdfRes.arrayBuffer());

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
    logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 502, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: `Couldn't fetch the rulebook automatically (${e instanceof Error ? e.message : "unknown error"}). Drag your copy in instead.` },
      { status: 502 }
    );
  }
}
