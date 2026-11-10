/**
 * Pure helper functions for the rulebook-fetch pipeline.
 *
 * Extracted from app/api/games/fetch-rulebook/route.ts so they can be
 * unit-tested in isolation (no Next.js runtime, no network I/O required).
 */

import dns from "dns";
import net from "net";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ─── HTML Entity Decoding ─────────────────────────────────────────────────────

/**
 * Decode common HTML entities in a URL string.
 * URLs extracted from HTML often contain &amp; instead of &, etc.
 */
export function decodeHtmlEntities(url: string): string {
  return url
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

// ─── File Share URL Resolver ──────────────────────────────────────────────────

/**
 * Resolve Dropbox/Google Drive share links to direct download URLs.
 * Returns the resolved URL or null if it's not a recognized file-share pattern.
 */
export function resolveFileShareUrl(url: string): string | null {
  try {
    // Normalize HTML entities that may have slipped through.
    const cleanUrl = decodeHtmlEntities(url);
    const parsed = new URL(cleanUrl);

    // Dropbox: www.dropbox.com/scl/fo/<id>/<token>?params → ensure dl=1 for direct download.
    // The GET request follows the redirect chain to the actual file server.
    // We do NOT convert to dl.dropboxusercontent.com because the path structure differs
    // and returns 404. Instead, we rely on the redirect from www.dropbox.com?dl=1.
    if (parsed.hostname.includes("dropbox.com") && parsed.pathname.startsWith("/scl/")) {
      const searchParams = new URLSearchParams(parsed.search);
      searchParams.set("dl", "1");
      return `${parsed.origin}${parsed.pathname}?${searchParams.toString()}`;
    }

    // Google Drive: drive.google.com/file/d/<fileId>/view → drive.google.com/uc?export=download&id=<fileId>
    if (parsed.hostname === "drive.google.com" && parsed.pathname.startsWith("/file/d/")) {
      // "/file/d/<fileId>/view".split("/") → ["", "file", "d", "<fileId>", "view"]
      const fileId = parsed.pathname.split("/")[3];
      if (fileId) {
        return `https://drive.google.com/uc?export=download&id=${fileId}`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Base-Game URL Check ──────────────────────────────────────────────────────

/**
 * Common rulebook descriptor words that indicate a base-game rulebook,
 * not an expansion. e.g., "scythe_rules.pdf" is the base game.
 */
export const RULEBOOK_DESCRIPTORS = new Set([
  "rules", "rulebook", "manual", "guide", "complete", "player", "aid",
  "howtoplay", "instructions", "book", "pdf",
]);

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
export function isUrlForBaseGame(url: string, gameName: string): boolean {
  const normalized = gameName.toLowerCase().replace(/[:\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");

  try {
    const parsed = new URL(url);
    // Decode URL-encoded characters (e.g., %20 → space) for proper matching.
    const pathSegments = parsed.pathname.split("/").filter(Boolean).map(s => {
      try { return decodeURIComponent(s); } catch { return s; }
    });

    // Find the segment that contains the normalized game name.
    let foundSegment = false;
    const lastSegIndex = pathSegments.length - 1;
    for (let si = 0; si < pathSegments.length; si++) {
      const segment = pathSegments[si];
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
        // Descriptor checks only apply to the FILENAME (last segment), not folders.
        // A folder like "NEMESIS_GUIDE" is an expansion, but a file like
        // "nemesis_guide.pdf" is the base game's guide.
        if (si === lastSegIndex) {
          // Rulebook descriptor: "<game_name>_<descriptor>". e.g., "scythe_rules", "nemesis_manual".
          if (segNoExt.startsWith(normalized)) {
            const suffix = segNoExt.slice(normalized.length);
            const cleaned = suffix.replace(/^[_\-\s]+/, "").replace(/[^a-z0-9]/g, "");
            if (RULEBOOK_DESCRIPTORS.has(cleaned)) {
              break;
            }
          }
          // Game name in the middle of the filename + rulebook descriptor present.
          // e.g., "CN3082 CATAN – 5-6 Rulebook 2025 reduced.pdf"
          const words = segNoExt.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
          if (words.some(w => RULEBOOK_DESCRIPTORS.has(w))) {
            break;
          }
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
      // If the filename starts with the game name:
      if (fileNoExt.startsWith(normalized)) {
        const suffix = fileNoExt.slice(normalized.length);
        // Short name variant (≤ 3 chars): "clue" → "cluedo".
        if (suffix.replace(/[^a-z0-9]/g, "").length <= 3) return true;
        // Rulebook descriptor: "scythe_rules", "nemesis_manual".
        const cleaned = suffix.replace(/^[_\-\s]+/, "").replace(/[^a-z0-9]/g, "");
        if (RULEBOOK_DESCRIPTORS.has(cleaned)) return true;
        // Otherwise, extra words → expansion.
        return false;
      }
      // Game name in the middle of the filename + rulebook descriptor present.
      const words = fileNoExt.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
      if (words.includes(normalized) && words.some(w => RULEBOOK_DESCRIPTORS.has(w))) {
        return true;
      }
      // If the filename doesn't contain the game name at all, reject it —
      // it's likely a different game's rulebook (e.g. "rulebook.pdf" under
      // a sibling game's folder).
      if (!fileNoExt.includes(normalized)) return false;
      return true;
    }

    // A segment matched. Now check the filename for expansion indicators.
    const filename = pathSegments[pathSegments.length - 1]?.toLowerCase() ?? "";
    const fileNoExt = filename.replace(/\.pdf$/i, "");

    // If the filename starts with the game name:
    if (fileNoExt.startsWith(normalized)) {
      const suffix = fileNoExt.slice(normalized.length);
      // Short name variant (≤ 3 chars): "clue" → "cluedo", "risk" → "riskclassic".
      if (suffix.replace(/[^a-z0-9]/g, "").length <= 3) return true;
      // Rulebook descriptor: "scythe_rules", "nemesis_manual".
      const cleaned = suffix.replace(/^[_\-\s]+/, "").replace(/[^a-z0-9]/g, "");
      if (RULEBOOK_DESCRIPTORS.has(cleaned)) return true;
      // e.g., "nemesis_voidseeders_rulebook_280x280mm_it.pdf"
      return false;
    }

    // Game name in the middle of the filename + rulebook descriptor present.
    const words = fileNoExt.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    if (words.includes(normalized) && words.some(w => RULEBOOK_DESCRIPTORS.has(w))) {
      return true;
    }

    // Generic rulebook filenames are fine: "rulebook.pdf", "rules.pdf", "nemesis.pdf"
    return true;
  } catch {
    return true; // Can't parse URL — allow it.
  }
}

// ─── PDF Validation ───────────────────────────────────────────────────────────

/**
 * Check if a URL serves a valid PDF.
 * Uses a GET request and reads only the first 4 bytes from the response stream,
 * then cancels the connection. Checks for the %PDF magic header (0x25 0x50 0x44 0x46).
 * This is more reliable than content-type headers (many servers don't set them correctly,
 * and Dropbox/Drive redirect chains return JSON for HEAD but actual files for GET).
 */
export async function isValidPdf(url: string): Promise<boolean> {
  try {
    // Resolve file-share URLs (Dropbox, Drive) to direct download links.
    const resolved = resolveFileShareUrl(url) ?? url;
    // Guarded fetch: the SSRF guard rejects private/internal hosts before any
    // network I/O. A blocked URL throws SsrfBlockedError, caught below → false.
    const res = await safeFetch(resolved, {
      method: "GET",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok || !res.body) return false;

    // Read only the first 4 bytes from the stream, then cancel.
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel(); // Stop downloading the rest.

    if (!value || value.length < 4) return false;
    // PDF magic bytes: %PDF (0x25 0x50 0x44 0x46)
    return value[0] === 0x25 && value[1] === 0x50 && value[2] === 0x44 && value[3] === 0x46;
  } catch {
    return false;
  }
}

// ─── Language Detection ────────────────────────────────────────────────────────

export const LANG_CODES = new Set(["en", "it", "de", "fr", "es", "pt", "nl", "sv", "no", "da", "fi", "pl", "cs", "hu", "ro", "tr", "ja", "ko", "zh"]);

// 3-letter ISO codes → 2-letter equivalent (for standalone path segments like /ENG/).
export const LANG_3_TO_2: Record<string, string> = {
  eng: "en", ger: "de", fre: "fr", ita: "it", spa: "es", por: "pt",
  dut: "nl", swe: "sv", nor: "no", dan: "da", fin: "fi", pol: "pl",
  cze: "cs", hun: "hu", rum: "ro", tur: "tr", jpn: "ja", kor: "ko", chi: "zh",
};

// 2-letter → uppercase 3-letter folder code (e.g., "en" → "ENG").
// Publisher sites organize rulebooks under 3-letter ISO folders (/ENG/, /DE/ is
// not used — it's /GER/), so probes must generate these.
export const LANG_2_TO_3: Record<string, string> = Object.fromEntries(
  Object.entries(LANG_3_TO_2).map(([three, two]) => [two, three.toUpperCase()])
);

// Generic words that commonly follow a language prefix in filenames.
export const GENERIC_DESCRIPTORS = new Set(["rulebook", "rules", "manual", "instructions", "guide", "pdf", "game", "board", "edition"]);

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
export function detectLanguage(url: string): string | null {
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

// ─── Download Size Guard ──────────────────────────────────────────────────────

/**
 * Maximum PDF download size in bytes. Legitimate rulebooks are typically
 * 1–20 MB; a multi-gigabyte payload from a malicious or buggy URL would
 * exhaust server memory, so the download is capped well above any real
 * rulebook.
 */
export const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100 MB

/** Thrown when a downloaded PDF exceeds MAX_PDF_SIZE. Maps to HTTP 413. */
export class PdfTooLargeError extends Error {
  constructor() {
    super(`PDF exceeds maximum size (${MAX_PDF_SIZE / (1024 * 1024)} MB)`);
    this.name = "PdfTooLargeError";
  }
}

/**
 * Read a response body into a Buffer while enforcing a maximum size.
 * Streams the body in chunks and tracks the accumulated byte count, aborting
 * the download as soon as the limit is exceeded — so memory usage stays
 * bounded instead of buffering an unbounded payload (unlike arrayBuffer()).
 */
export async function readWithSizeLimit(res: Response, maxSize: number): Promise<Buffer<ArrayBuffer>> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > maxSize) {
        await reader.cancel();
        throw new PdfTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Declared as Buffer<ArrayBuffer> (not a bare Buffer, which widens to
  // ArrayBufferLike and is not assignable to the Response body's BodyInit).
  return Buffer.concat(chunks, totalSize);
}

/**
 * Check if a URL's detected language is compatible with the desired language.
 * Returns true if:
 *   - No language is specified (no constraint), OR
 *   - No language tag is found in the URL (can't determine → allow), OR
 *   - The detected language matches the desired language.
 * Returns false if a language tag is found and it does NOT match.
 */
export function isLanguageCompatible(url: string, desired?: string): boolean {
  if (!desired) return true;
  const detected = detectLanguage(url);
  if (!detected) return true; // No tag found — can't determine, allow it.
  return detected === desired.toLowerCase();
}

// ─── SSRF Guard ────────────────────────────────────────────────────────────────

/** Thrown when a URL is blocked by the SSRF guard. Maps to HTTP 403. */
export class SsrfBlockedError extends Error {
  constructor(url: string) {
    super(`Blocked URL (points to a private/internal address): ${url}`);
    this.name = "SsrfBlockedError";
  }
}

/**
 * Check if an IPv4 address is in a private/reserved range that must be blocked
 * to prevent SSRF attacks.
 *
 * Blocked: RFC1918 private ranges (10/8, 172.16/12, 192.168/16), link-local
 *   169.254/16 (includes the cloud metadata endpoint 169.254.169.254), the
 *   "this network" range 0.0.0.0/8 (empirically routes to loopback on this
 *   host), and the loopback range 127/8 EXCEPT 127.0.0.1 (allowed for this
 *   self-hosted app).
 * Allowed: all public addresses and 127.0.0.1.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // fail closed on malformed input
  }
  const [a, b] = parts;
  if (a === 0) return true;                                        // 0.0.0.0/8 ("this network" — routes to loopback)
  if (a === 10) return true;                                       // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;                 // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                          // 192.168.0.0/16
  if (a === 169 && b === 254) return true;                          // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 127 && !(b === 0 && parts[2] === 0 && parts[3] === 1)) return true; // 127.0.0.0/8 minus 127.0.0.1
  return false;
}

/**
 * Expand an IPv6 address into its eight 16-bit groups. Returns null if the
 * address is malformed. Handles "::" compression and a trailing dotted-decimal
 * IPv4 (the IPv4-mapped form, e.g. ::ffff:10.0.0.1).
 */
function expandIPv6(ip: string): number[] | null {
  const addr = ip.toLowerCase().split("%")[0]; // strip zone id, e.g. fe80::1%eth0
  let parts = addr.split(":");

  // Expand a trailing dotted-decimal IPv4 into two 16-bit hex groups.
  const last = parts[parts.length - 1];
  if (last.includes(".")) {
    const nums = last.split(".").map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    parts.pop();
    // Push as HEX strings so the shared parseInt(h, 16) parse loop reads them
    // back correctly (a decimal "2560" would be misread as 0x2560).
    parts.push(((nums[0] << 8) | nums[1]).toString(16), ((nums[2] << 8) | nums[3]).toString(16));
  }

  let groups: string[];
  const emptyCount = parts.filter((s) => s === "").length;
  if (emptyCount >= 1) {
    // "::" compression present.
    const firstEmptyIdx = parts.indexOf("");
    const leftParts = parts.slice(0, firstEmptyIdx);
    const rightParts = parts.slice(firstEmptyIdx + 1).filter((s) => s !== "");
    if (leftParts.length + rightParts.length > 7) return null;
    const missing = 8 - leftParts.length - rightParts.length;
    groups = [...leftParts, ...Array(missing).fill("0"), ...rightParts];
  } else {
    groups = parts;
    if (groups.length !== 8) return null;
  }

  const out: number[] = [];
  for (const h of groups) {
    const val = parseInt(h, 16);
    if (Number.isNaN(val) || val < 0 || val > 0xffff) return null;
    out.push(val);
  }
  return out;
}

/**
 * Check if an IPv6 address is in a private/reserved range that must be blocked.
 * Blocked: ::1 (loopback), fe80::/10 (link-local, consistent with blocking
 *   169.254/16 for IPv4), fc00::/7 (unique local), and IPv4-mapped
 *   ::ffff:0:0/96 addresses whose embedded IPv4 is itself private.
 */
export function isPrivateIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (!groups) return true; // fail closed on malformed input

  // ::1 (loopback).
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1
  ) {
    return true;
  }

  // fe80::/10 (link-local): top 10 bits of the first group are 1111111010.
  if ((groups[0] & 0xffc0) === 0xfe80) return true;

  // fc00::/7 (unique local): top 7 bits of the first group are 1111110.
  if ((groups[0] & 0xfe00) === 0xfc00) return true;

  // ::ffff:0:0/96 (IPv4-mapped): first 96 bits are 0:0:0:0:0:ffff and the last
  // 32 bits form an IPv4 address — evaluate that embedded IPv4 as IPv4.
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && groups[5] === 0xffff
  ) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPrivateIPv4(ipv4);
  }

  return false;
}

/**
 * SSRF guard: verify that a URL's host resolves only to public (non-internal)
 * IP addresses before it may be fetched server-side.
 *
 * - Literal IP hosts are checked directly (no DNS lookup).
 * - Domain names are resolved via DNS (A + AAAA); ALL resolved addresses must be
 *   public, otherwise the URL is rejected (fail closed).
 * - `localhost` and `127.0.0.1` are allowed for this self-hosted app.
 * - Cloud metadata (169.254.x.x) and RFC1918 private ranges are always blocked.
 *
 * Resolves to true if the URL is safe to fetch, false otherwise.
 */
export async function isSafeUrl(url: string): Promise<boolean> {
  let hostname: string;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
  } catch {
    return false; // can't parse → fail closed
  }

  // Strip brackets from an IPv6 literal host (e.g. "[::1]" → "::1").
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (!host) return false; // empty host → fail closed

  // Allow self-hosted dev/testing targets.
  if (host === "localhost" || host === "127.0.0.1") return true;

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return !isPrivateIPv4(host);
  if (ipVersion === 6) return !isPrivateIPv6(host);

  // Domain name → resolve via DNS and check ALL A + AAAA records.
  const ips: string[] = [];
  try {
    const v4 = await dns.promises.lookup(host, { family: 4, all: true });
    ips.push(...v4.map((r) => r.address));
  } catch {
    /* no A records */
  }
  try {
    const v6 = await dns.promises.lookup(host, { family: 6, all: true });
    ips.push(...v6.map((r) => r.address));
  } catch {
    /* no AAAA records */
  }

  if (ips.length === 0) return false; // resolution failed → fail closed

  for (const ip of ips) {
    if (ip.includes(":") ? isPrivateIPv6(ip) : isPrivateIPv4(ip)) return false;
  }
  return true;
}

/**
 * Maximum HTML page size in bytes. Legitimate rulebook/publisher pages are
 * typically 50–200 KB; a multi-gigabyte payload from a malicious or buggy
 * server would exhaust server memory, so the read is capped well above any
 * real HTML page.
 */
export const MAX_HTML_SIZE = 1024 * 1024; // 1 MB

/** Thrown when an HTML page exceeds MAX_HTML_SIZE. Callers should skip the candidate. */
export class HtmlTooLargeError extends Error {
  constructor() {
    super(`HTML page exceeds maximum size (${MAX_HTML_SIZE / (1024 * 1024)} MB)`);
    this.name = "HtmlTooLargeError";
  }
}

/**
 * Fetch a URL and read its body as a UTF-8 string, enforcing a maximum size.
 *
 * Uses safeFetch for SSRF protection, then streams the body in chunks via
 * res.body.getReader() so memory usage stays bounded. If the accumulated byte
 * count exceeds maxSize, the reader is cancelled and HtmlTooLargeError is thrown.
 *
 * Callers should catch HtmlTooLargeError and skip the candidate gracefully.
 */
export async function fetchTextWithLimit(url: string, maxSize: number, init?: RequestInit): Promise<string> {
  const res = await safeFetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  if (!res.body) return "";

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > maxSize) {
        await reader.cancel();
        throw new HtmlTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Concatenate and decode as UTF-8.
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8").decode(buffer);
}

/**
 * Guarded fetch: runs the SSRF guard before issuing the request. Throws
 * SsrfBlockedError if the URL points to a private/internal address, so callers
 * never touch the network with a blocked host.
 *
 * Redirects are followed manually (up to `maxRedirects` hops) and EVERY hop is
 * re-validated by the guard. This closes the redirect-following bypass where a
 * public page 302s to an unvalidated internal Location target.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const maxRedirects = 5;
  let currentUrl = url;

  for (let i = 0; i <= maxRedirects; i++) {
    if (!await isSafeUrl(currentUrl)) {
      throw new SsrfBlockedError(currentUrl);
    }

    const res = await fetch(currentUrl, { ...init, redirect: "manual" });

    // If it's a redirect, follow it (with validation).
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Redirect with no Location header");
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return res;
  }

  throw new Error("Too many redirects");
}
