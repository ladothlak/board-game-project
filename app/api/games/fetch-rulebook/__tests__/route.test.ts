/**
 * Integration-style tests for the rulebook fetch pipeline.
 *
 * Exercises the real POST handler with all external I/O mocked:
 *   - Node's http/https modules (PDF validation + downloads, via fetchPinned)
 *   - fs (persistent known-rulebooks cache)
 *   - rate limiting and audit logging
 *
 * Verifies the strategy cascade: direct URL → Strategy 1 (known URLs) →
 * Strategy 2 (publisher base probe) → Strategy 3 (web search) →
 * Strategy 4 (site scan), with learning persisted when a non-known
 * strategy succeeds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { POST } from "../route";
import { MAX_PDF_SIZE, PdfTooLargeError, readWithSizeLimit } from "@/lib/fetch-rulebook-utils";
import { checkRate } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { makeFakeRequest } from "@/lib/__tests__/http-mock";

vi.mock("@/lib/rate-limit", () => ({
  checkRate: vi.fn(() => ({ allowed: true })),
  getClientIp: vi.fn(() => "test-ip"),
}));
vi.mock("@/lib/audit-log", () => ({
  logRequest: vi.fn(),
}));
vi.mock("fs/promises", () => ({
  readFile: vi.fn(() => Promise.reject(new Error("ENOENT"))),
  writeFile: vi.fn(() => Promise.resolve()),
}));
// The SSRF guard resolves hostnames via DNS before fetching. In these tests the
// domains are fakes, so resolve every hostname to a public IPv4 address (and no
// AAAA record) so the guard treats them as safe and the strategy cascade runs.
vi.mock("dns", () => ({
  default: {
    promises: {
      lookup: (_host: string, opts: { family: number }) =>
        Promise.resolve(
          opts.family === 4 ? [{ address: "93.184.216.34", family: 4 }] : []
        ),
    },
  },
}));
// safeFetch (via fetchPinned) dials the pinned IP through Node's http/https
// modules, so we mock those instead of globalThis.fetch.
const mockRequest = vi.hoisted(() => vi.fn());
vi.mock("http", () => ({
  default: { request: (...args: unknown[]) => mockRequest(...args) },
}));
vi.mock("https", () => ({
  default: { request: (...args: unknown[]) => mockRequest(...args) },
}));

// ─── Helpers ────────────────────────────────────────────────────────────────────

type FakeResponse = { status: number; headers?: Record<string, string>; body?: string | Buffer };

function pdfResponse(extra = ""): FakeResponse {
  return {
    status: 200,
    headers: { "Content-Type": "application/pdf" },
    body: Buffer.from(`%PDF-1.4\n${extra}`),
  };
}

function htmlResponse(): FakeResponse {
  return {
    status: 200,
    headers: { "Content-Type": "text/html" },
    body: "<!DOCTYPE html><html><body>not a pdf</body></html>",
  };
}

function jsonResponse(data: unknown, status = 200): FakeResponse {
  return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

/** HTML page with plain (unlabeled) links — sufficient for PDF-link extraction. */
function htmlWithLinks(links: string[]): FakeResponse {
  const body = links.map((l) => `<a href="${l}">link</a>`).join("");
  return { status: 200, headers: { "Content-Type": "text/html" }, body };
}

/** HTML page with labeled links — needed for sub-page discovery (label must match rule/download/etc.). */
function htmlWithLabeledLinks(links: Array<{ href: string; label: string }>): FakeResponse {
  const body = links.map(({ href, label }) => `<a href="${href}">${label}</a>`).join("");
  return { status: 200, headers: { "Content-Type": "text/html" }, body };
}

/**
 * Route the mocked http/https.request by original hostname (preserved in the
 * Host header by fetchPinned) + path. Unmatched requests get a 404.
 */
function setHttpRouting(
  routes: Array<[string | RegExp, () => FakeResponse]>
): void {
  mockRequest.mockImplementation(
    (options: { headers: Record<string, string>; path: string }, callback: (res: unknown) => void) => {
      const host = options.headers.Host ?? "";
      const path = options.path ?? "";
      for (const [pattern, makeResponse] of routes) {
        const haystack = `${host}\n${path}`;
        const matches = typeof pattern === "string" ? haystack.includes(pattern) : pattern.test(haystack);
        if (matches) {
          const r = makeResponse();
          return makeFakeRequest(r.status, r.headers ?? {}, r.body ?? "", callback);
        }
      }
      return makeFakeRequest(404, {}, "not found", callback);
    }
  );
}

/** Reconstruct the host+path haystack for a recorded mockRequest call. */
function requestHaystack(call: unknown[]): string {
  const options = call[0] as { headers?: Record<string, string>; path?: string } | undefined;
  return `${options?.headers?.Host ?? ""}\n${options?.path ?? ""}`;
}

function post(body: unknown): Promise<Response> {
  const init = typeof body === "string"
    ? { method: "POST" as const, body }
    : {
        method: "POST" as const,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      };
  return POST(new Request("http://localhost/api/games/fetch-rulebook", init));
}

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);

beforeEach(() => {
  mockRequest.mockReset();
  // No Brave API key → Strategy 3 is skipped deterministically.
  vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
  mockedReadFile.mockReset().mockRejectedValue(new Error("ENOENT"));
  mockedWriteFile.mockReset();
  vi.mocked(checkRate).mockReset().mockReturnValue({ allowed: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/games/fetch-rulebook", () => {
  it("Strategy 1: serves a static known URL and does not re-persist it", async () => {
    // "Nemesis Lockdown" is in the static KNOWN_RULEBOOK_URLS dict.
    const staticUrl =
      "https://awakenrealms.com/images/download/Nemesis_Lockdown/ENG/Nemesis_LD_Rulebook_280x280mm_bleed3mm-32-pages.pdf";
    setHttpRouting([["Nemesis_LD_Rulebook", pdfResponse]]);

    const res = await post({ gameName: "Nemesis Lockdown" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(staticUrl);
    expect(res.headers.get("X-Found-Via")).toBe("known");
    // "known" findings are not re-persisted (already in the static dict).
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it("Cascade: Strategy 1 fails, Strategy 2 (publisher probe) succeeds and learns", async () => {
    // Seed the learned publisher base URL (as if a previous request had learned it).
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        games: {},
        publishers: {
          "awaken realms": {
            baseUrl: "https://awakenrealms.com/images/download/",
            domain: "awakenrealms.com",
          },
        },
      })
    );

    // Strategy 1's Hasbro pattern candidates serve HTML (not PDFs)…
    // …and the learned base URL's first candidate serves a real PDF.
    const probeUrl = "https://awakenrealms.com/images/download/Nemesis/ENG/rulebook.pdf";
    setHttpRouting([["hasbro.com", htmlResponse], ["/images/download/Nemesis/ENG/rulebook.pdf", pdfResponse]]);

    const res = await post({ gameName: "Nemesis", publisherName: "Awaken Realms" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(probeUrl);
    expect(res.headers.get("X-Found-Via")).toBe("probe");
    // Non-known findings are persisted for future requests.
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    const [file, raw] = mockedWriteFile.mock.calls[0];
    const data = JSON.parse(String(raw));
    expect(data.games["nemesis"]).toBe(probeUrl);
  });

  it("Direct URL short-circuits all strategies", async () => {
    const directUrl = "https://x.com/Nemesis/ENG/rulebook.pdf";
    setHttpRouting([["/Nemesis/ENG/rulebook.pdf", pdfResponse]]);

    const res = await post({ gameName: "Nemesis", directUrl });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(directUrl);
    expect(res.headers.get("X-Found-Via")).toBe("direct");
  });

  it("Returns 404 when every strategy fails", async () => {
    // No publisher info → autoLookupPublisher is tried (Wikipedia, mocked to fail).
    // Strategy 1: Hasbro pattern candidates serve HTML.
    // Strategy 2: no learned publisher. Strategy 3: no API key. Strategy 4: no publisher URL.
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 404, body: "nf" })],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt" });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("No rulebook PDF found");
  });

  it("Returns 429 when rate-limited", async () => {
    vi.mocked(checkRate).mockReturnValue({ allowed: false, retryAfter: 30 });

    const res = await post({ gameName: "Nemesis" });

    expect(res.status).toBe(429);
  });

  it("Returns 400 for an invalid JSON body", async () => {
    const res = await post("this is not json");
    expect(res.status).toBe(400);
  });

  it("Returns the PDF bytes with the expected headers on success", async () => {
    const directUrl = "https://x.com/Nemesis/ENG/rulebook.pdf";
    setHttpRouting([["/Nemesis/ENG/rulebook.pdf", () => pdfResponse("hello")]]);

    const res = await post({ gameName: "Nemesis", directUrl });
    const text = await res.text();

    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
  });

  it("Returns 502 when the found URL stops serving a valid PDF at download time", async () => {
    // The Wikipedia auto-lookup fetch is answered by the default 404 route.
    // isValidPdf passes on the first directUrl fetch (PDF)…
    const directUrl = "https://x.com/Nemesis/ENG/rulebook.pdf";
    let directCalls = 0;
    setHttpRouting([["/Nemesis/ENG/rulebook.pdf", () => {
      directCalls++;
      return directCalls === 1 ? pdfResponse() : htmlResponse();
    }]]);
    // …but the download call returns HTML, failing the %PDF sanity check.
    const res = await post({ gameName: "Nemesis", directUrl });

    expect(res.status).toBe(502);
  });
});

// ─── PDF Size Cap ──────────────────────────────────────────────────────────────

describe("PDF size cap", () => {
  it("returns 413 when the downloaded PDF exceeds MAX_PDF_SIZE", async () => {
    const directUrl = "https://x.com/Nemesis/ENG/rulebook.pdf";
    // A body just over the cap, starting with the %PDF magic bytes so the
    // validation fetch (which only reads 4 bytes) passes and the full
    // download is what trips the cap. The buffer is shared between the
    // validation and download responses to keep the test's memory bounded.
    const oversized = Buffer.alloc(MAX_PDF_SIZE + 64);
    oversized.write("%PDF", 0);
    setHttpRouting([["/Nemesis/ENG/rulebook.pdf", () => ({
      status: 200,
      headers: { "Content-Type": "application/pdf" },
      body: oversized,
    })]]);

    const res = await post({ gameName: "Nemesis", directUrl });

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain("too large");
  });

  it("serves a normal-sized PDF without hitting the cap", async () => {
    const directUrl = "https://x.com/Nemesis/ENG/rulebook.pdf";
    setHttpRouting([["/Nemesis/ENG/rulebook.pdf", pdfResponse]]);

    const res = await post({ gameName: "Nemesis", directUrl });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });
});

describe("readWithSizeLimit", () => {
  it("returns the full body when within the limit", async () => {
    const res = new Response(new TextEncoder().encode("hello world"), { status: 200 });
    const buf = await readWithSizeLimit(res, 100);
    expect(buf.toString()).toBe("hello world");
  });

  it("throws PdfTooLargeError when the body exceeds the limit", async () => {
    const res = new Response(new TextEncoder().encode("hello world"), { status: 200 });
    await expect(readWithSizeLimit(res, 5)).rejects.toThrow(PdfTooLargeError);
  });

  it("returns an empty buffer for a bodyless response", async () => {
    const res = new Response(null, { status: 200 });
    const buf = await readWithSizeLimit(res, 100);
    expect(buf.length).toBe(0);
  });
});

// ─── Strategy 3: Targeted Web Search (Brave API) ──────────────────────────────

describe("Strategy 3: webSearchForPdf (Brave Search)", () => {
  it("selects a direct PDF from Brave search results", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const pdfUrl = "https://example.com/zorblatt/rules.pdf";
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: pdfUrl }] } })],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(pdfUrl);
    expect(res.headers.get("X-Found-Via")).toBe("search");
  });

  it("follows HTML results to find PDF links on publisher pages", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const pageUrl = "https://example.com/zorblatt";
    const pdfUrl = "https://example.com/zorblatt/rules.pdf";
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: pageUrl }] } })],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["/zorblatt", () => htmlWithLinks([pdfUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(pdfUrl);
    expect(res.headers.get("X-Found-Via")).toBe("search");
  });

  it("resolves Dropbox links found on followed pages", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const pageUrl = "https://example.com/zorblatt";
    // The path contains the game name so it passes the base-game check;
    // resolveFileShareUrl appends ?dl=1 for the validation/download fetches.
    const dropboxUrl = "https://www.dropbox.com/scl/fo/zorblatt/rulebook.pdf";
    const resolvedDropbox = "https://www.dropbox.com/scl/fo/zorblatt/rulebook.pdf?dl=1";
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: pageUrl }] } })],
      ["/scl/fo/zorblatt/rulebook.pdf", pdfResponse],
      ["/zorblatt", () => htmlWithLinks([dropboxUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    // The original (unresolved) Dropbox URL is what gets reported.
    expect(res.headers.get("X-Pdf-Url")).toBe(dropboxUrl);
  });

  it("skips the strategy immediately when no Brave API key is configured", async () => {
    // BRAVE_SEARCH_API_KEY is "" from beforeEach. Even though Brave *would*
    // return a valid PDF, the strategy is skipped without a key → 404.
    const pdfUrl = "https://example.com/zorblatt/rules.pdf";
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: pdfUrl }] } })],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher" });

    expect(res.status).toBe(404);
  });

  it("returns null gracefully when the Brave API errors", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    setHttpRouting([
      ["api.search.brave.com", () => ({ status: 500, body: "server error" })],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher" });

    expect(res.status).toBe(404);
  });

  it("skips candidates that are in the excluded set", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const excludedUrl = "https://example.com/zorblatt/excluded-rules.pdf";
    const validUrl = "https://example.com/zorblatt/rules.pdf";
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: excludedUrl }, { url: validUrl }] } })],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["/zorblatt/excluded-rules.pdf", pdfResponse], // would be valid if not excluded
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher", excludeUrls: [excludedUrl] });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(validUrl);
  });

  it("skips candidates whose detected language does not match the requested one", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const enUrl = "https://example.com/zorblatt/ENG/rules.pdf"; // English tag → rejected for "fr"
    const frUrl = "https://example.com/zorblatt/FRE/rules.pdf"; // French tag → accepted
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: enUrl }, { url: frUrl }] } })],
      ["/zorblatt/ENG/rules.pdf", pdfResponse],
      ["/zorblatt/FRE/rules.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher", language: "fr" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(frUrl);
  });

  it("accepts expansion URLs when isExpansion is true (bypassing the base-game check)", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    // "Nemesis_Lockdown" is an expansion folder — isUrlForBaseGame would reject it,
    // but isExpansion=true bypasses that check.
    const expansionUrl = "https://example.com/Nemesis_Lockdown/ENG/rulebook.pdf";
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: expansionUrl }] } })],
      ["/Nemesis_Lockdown/ENG/rulebook.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Nemesis", isExpansion: true, publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(expansionUrl);
  });

  it("selects the first valid PDF when multiple candidates exist", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const firstUrl = "https://example.com/zorblatt/first.pdf";
    const secondUrl = "https://example.com/zorblatt/second.pdf";
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: firstUrl }, { url: secondUrl }] } })],
      ["/zorblatt/first.pdf", pdfResponse],
      ["/zorblatt/second.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(firstUrl);
  });

  it("returns null when all candidates fail PDF validation", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const badUrl = "https://example.com/zorblatt/bad.pdf";
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: badUrl }] } })],
      ["/zorblatt/bad.pdf", htmlResponse], // Not a PDF.
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher" });

    expect(res.status).toBe(404);
  });
});

// ─── Strategy 4: Publisher Site Scan ──────────────────────────────────────────

describe("Strategy 4: scanPublisherSite", () => {
  it("finds a rulebook PDF linked directly on the publisher homepage", async () => {
    const homeUrl = "https://publisher.com";
    const pdfUrl = "https://publisher.com/zorblatt/rules.pdf";
    setHttpRouting([
      ["/zorblatt/rules.pdf", pdfResponse],
      [/^publisher\.com\n\/$/, () => htmlWithLinks([pdfUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: homeUrl, publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(pdfUrl);
    expect(res.headers.get("X-Found-Via")).toBe("scan");
  });

  it("follows sub-pages to find a rulebook PDF", async () => {
    const homeUrl = "https://publisher.com";
    const subUrl = "https://publisher.com/rules";
    const pdfUrl = "https://publisher.com/zorblatt/rules.pdf";
    setHttpRouting([
      ["/zorblatt/rules.pdf", pdfResponse],
      ["/rules", () => htmlWithLinks([pdfUrl])],
      [/^publisher\.com\n\/$/, () => htmlWithLabeledLinks([{ href: subUrl, label: "Rules" }])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: homeUrl, publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(pdfUrl);
  });

  it("tries common path patterns when no links are found on the site", async () => {
    const homeUrl = "https://publisher.com";
    // No PDF links and no sub-page links on the homepage, so the strategy falls
    // back to guessing paths like /rules/<slug>.pdf.
    const commonUrl = "https://publisher.com/rules/zorblatt.pdf";
    setHttpRouting([
      ["/rules/zorblatt.pdf", pdfResponse],
      [/^publisher\.com\n\/$/, () => htmlResponse()],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: homeUrl, publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(commonUrl);
  });

  it("skips excluded PDF links on the homepage", async () => {
    const homeUrl = "https://publisher.com";
    // The only PDF link on the site is in the excluded set → nothing found.
    const excludedUrl = "https://publisher.com/zorblatt/excluded-rules.pdf";
    setHttpRouting([
      ["/zorblatt/excluded-rules.pdf", pdfResponse], // would be valid if not excluded
      [/^publisher\.com\n\/$/, () => htmlWithLinks([excludedUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({
      gameName: "Zorblatt",
      publisherUrl: homeUrl,
      publisherName: "Some Publisher",
      excludeUrls: [excludedUrl],
    });

    expect(res.status).toBe(404);
  });

  it("skips unreachable sub-pages gracefully", async () => {
    const homeUrl = "https://publisher.com";
    const subUrl = "https://publisher.com/rules";
    setHttpRouting([
      ["/rules", () => ({ status: 500, body: "server error" })],
      [/^publisher\.com\n\/$/, () => htmlWithLabeledLinks([{ href: subUrl, label: "Rules" }])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: homeUrl, publisherName: "Some Publisher" });

    // The sub-page is unreachable and no common path works → 404.
    expect(res.status).toBe(404);
  });

  it("resolves Dropbox links found on sub-pages", async () => {
    const homeUrl = "https://publisher.com";
    const subUrl = "https://publisher.com/rules";
    // The path contains the game name so it passes the base-game check;
    // resolveFileShareUrl appends ?dl=1 for the validation/download fetches.
    const dropboxUrl = "https://www.dropbox.com/scl/fo/zorblatt/rulebook.pdf";
    const resolvedDropbox = "https://www.dropbox.com/scl/fo/zorblatt/rulebook.pdf?dl=1";
    setHttpRouting([
      ["/scl/fo/zorblatt/rulebook.pdf", pdfResponse],
      ["/rules", () => htmlWithLinks([dropboxUrl])],
      [/^publisher\.com\n\/$/, () => htmlWithLabeledLinks([{ href: subUrl, label: "Rules" }])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: homeUrl, publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    // The original (unresolved) Dropbox URL is what gets reported.
    expect(res.headers.get("X-Pdf-Url")).toBe(dropboxUrl);
  });

  it("applies language filtering to homepage candidates", async () => {
    const homeUrl = "https://publisher.com";
    // Exact-match regex: only the bare homepage URL (with or without a trailing
    // slash) hits this route — sub-page URLs must not match it as a substring.
    const homeRoute = /^publisher\.com\n\/$/;
    const enUrl = "https://publisher.com/zorblatt/ENG/rules.pdf"; // English tag → rejected for "de"
    const deUrl = "https://publisher.com/zorblatt/GER/rules.pdf"; // German tag → accepted
    // The homepage links to a rules sub-page where the PDF candidates live.
    // enUrl is listed first, so the language filter must reject it before deUrl.
    const subUrl = "https://publisher.com/rules";
    setHttpRouting([
      ["/zorblatt/ENG/rules.pdf", pdfResponse],
      ["/zorblatt/GER/rules.pdf", pdfResponse],
      [homeRoute, () => htmlWithLabeledLinks([{ href: subUrl, label: "Rules" }])],
      ["/rules", () => htmlWithLinks([enUrl, deUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: homeUrl, publisherName: "Some Publisher", language: "de" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(deUrl);
  });
});

// ─── Auto-Lookup Publisher (Wikipedia) ────────────────────────────────────────

const ZORB_HOME = "https://zorb.com";
const zorbPdfUrl = "https://zorb.com/zorblatt/rules.pdf";

describe("autoLookupPublisher (Wikipedia lookup)", () => {
  it("finds the article via opensearch, parses it, and extracts publisher info", async () => {
    const wikitext = "{{Infobox board game\n| publisher = Zorb Games\n| website = https://zorb.com\n}}";
    setHttpRouting([
      ["action=opensearch", () => jsonResponse(["Zorblatt (board game)", ["Zorblatt (board game)"], [], []])],
      ["action=parse", () => jsonResponse({ parse: { wikitext: { "*": wikitext } } })],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["zorb.com", () => htmlWithLinks([zorbPdfUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt" });

    expect(res.status).toBe(200);
    // The parse call followed the opensearch hit, for the article that was found.
    const parseCalls = mockRequest.mock.calls.filter((call) => requestHaystack(call).includes("action=parse"));
    expect(parseCalls.length).toBe(1);
    expect(requestHaystack(parseCalls[0])).toContain(encodeURIComponent("Zorblatt (board game)"));
    // The extracted website drove Strategy 4, and the extracted name was persisted.
    expect(res.headers.get("X-Found-Via")).toBe("scan");
    const [, raw] = mockedWriteFile.mock.calls[0];
    const data = JSON.parse(String(raw));
    expect(data.publishers["zorb games"].domain).toBe("zorb.com");
  });

  it("extracts the publisher name from the infobox so the learned-publisher probe can use it", async () => {
    // Seed a learned publisher whose key only matches if "Zorb Games" is
    // extracted correctly from the wikitext.
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        games: {},
        publishers: { "zorb games": { baseUrl: "https://zorb.com/", domain: "zorb.com" } },
      })
    );
    const probeUrl = "https://zorb.com/Zorblatt/ENG/rulebook.pdf";
    setHttpRouting([
      ["action=opensearch", () => jsonResponse(["Zorblatt (board game)", ["Zorblatt (board game)"], [], []])],
      [
        "action=parse",
        // A field follows the publisher line so the infobox regex stops at the next `|`.
        () => jsonResponse({ parse: { wikitext: { "*": "{{Infobox board game\n| publisher = Zorb Games\n| designer = Someone\n}}" } } }),
      ],
      ["/Zorblatt/ENG/rulebook.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt" });

    // foundVia=probe only happens if the extracted name matched the seeded key.
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Found-Via")).toBe("probe");
    expect(res.headers.get("X-Pdf-Url")).toBe(probeUrl);
  });

  it("extracts the website URL from the infobox so Strategy 4 can scan it", async () => {
    setHttpRouting([
      ["action=opensearch", () => jsonResponse(["Zorblatt (board game)", ["Zorblatt (board game)"], [], []])],
      [
        "action=parse",
        () => jsonResponse({ parse: { wikitext: { "*": "{{Infobox board game\n| website = https://zorb.com\n}}" } } }),
      ],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["zorb.com", () => htmlWithLinks([zorbPdfUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt" });

    // foundVia=scan only happens if the website URL was extracted and used.
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Found-Via")).toBe("scan");
  });

  it("returns null when opensearch finds no article, and the cascade continues without publisher info", async () => {
    setHttpRouting([
      ["action=opensearch", () => jsonResponse(["Zorblatt board game", [], [], []])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt" });

    expect(res.status).toBe(404);
    // No article → the parse API is never called.
    expect(mockRequest.mock.calls.some((call) => requestHaystack(call).includes("action=parse"))).toBe(false);
  });

  it("returns null gracefully when the Wikipedia API errors", async () => {
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 500, body: "server error" })],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt" });

    expect(res.status).toBe(404);
    // The lookup failed before any parse call was made.
    expect(mockRequest.mock.calls.some((call) => requestHaystack(call).includes("action=parse"))).toBe(false);
  });

  it("skips the Wikipedia lookup entirely when publisher info is already provided", async () => {
    setHttpRouting([
      ["/zorblatt/rules.pdf", pdfResponse],
      ["zorb.com", () => htmlWithLinks([zorbPdfUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: ZORB_HOME, publisherName: "Zorb Games" });

    expect(res.status).toBe(200);
    expect(mockRequest.mock.calls.some((call) => requestHaystack(call).includes("wikipedia.org"))).toBe(false);
  });
});

// ─── Persist Finding (learning persistence) ────────────────────────────────────

describe("persistFinding (learning persistence)", () => {
  it("writes a newly found URL into known-rulebooks.json", async () => {
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 404, body: "nf" })],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["zorb.com", () => htmlWithLinks([zorbPdfUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: ZORB_HOME });

    expect(res.status).toBe(200);
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    const [file, raw] = mockedWriteFile.mock.calls[0];
    expect(file).toContain("known-rulebooks.json");
    const data = JSON.parse(String(raw));
    expect(data.games["zorblatt"]).toBe(zorbPdfUrl);
  });

  it("does not re-persist a URL that is already served from the cache", async () => {
    // Seed the persistent cache with this game's rulebook.
    mockedReadFile.mockResolvedValue(JSON.stringify({ games: { zorblatt: zorbPdfUrl }, publishers: {} }));
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 404, body: "nf" })],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt" });

    // Strategy 1 hits the cache → "known" findings are not re-persisted.
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Found-Via")).toBe("known");
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it("updates an existing game entry in place instead of duplicating it", async () => {
    const oldUrl = "https://zorb.com/zorblatt/old-rules.pdf";
    mockedReadFile.mockResolvedValue(JSON.stringify({ games: { zorblatt: oldUrl }, publishers: {} }));
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 404, body: "nf" })],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["zorb.com", () => htmlWithLinks([zorbPdfUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    // The cached URL is excluded, so a fresh scan finds the new one.
    const res = await post({ gameName: "Zorblatt", publisherUrl: ZORB_HOME, excludeUrls: [oldUrl] });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Found-Via")).toBe("scan");
    const [, raw] = mockedWriteFile.mock.calls[0];
    const data = JSON.parse(String(raw));
    // Single entry for the game, updated to the new URL — no duplication.
    expect(Object.keys(data.games)).toEqual(["zorblatt"]);
    expect(data.games["zorblatt"]).toBe(zorbPdfUrl);
  });

  it("learns the publisher's base URL and domain into the publishers map", async () => {
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 404, body: "nf" })],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["zorb.com", () => htmlWithLinks([zorbPdfUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: ZORB_HOME, publisherName: "Zorb Games" });

    expect(res.status).toBe(200);
    const [, raw] = mockedWriteFile.mock.calls[0];
    const data = JSON.parse(String(raw));
    expect(data.publishers["zorb games"]).toEqual({
      baseUrl: "https://zorb.com/zorblatt/rules.pdf/",
      domain: "zorb.com",
    });
  });

  it("does not crash the route when persisting to disk fails", async () => {
    mockedWriteFile.mockRejectedValue(new Error("ENOSPC: no space left on device"));
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 404, body: "nf" })],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["zorb.com", () => htmlWithLinks([zorbPdfUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: ZORB_HOME });

    // Persistence is non-critical — the PDF is still served.
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(zorbPdfUrl);
  });

  it("persists learning that a subsequent request reads back from the cache", async () => {
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 404, body: "nf" })],
      ["/zorblatt/rules.pdf", pdfResponse],
      ["zorb.com", () => htmlWithLinks([zorbPdfUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: ZORB_HOME });
    expect(res.status).toBe(200);

    // Read back the mocked file content that was written.
    const [file, raw] = mockedWriteFile.mock.calls[0];
    expect(file).toContain("known-rulebooks.json");
    const persisted = JSON.parse(String(raw));
    expect(persisted.games["zorblatt"]).toBe(zorbPdfUrl);

    // Simulate the next request reading the learned cache from disk.
    mockedReadFile.mockResolvedValue(String(raw));

    const res2 = await post({ gameName: "Zorblatt" });
    expect(res2.status).toBe(200);
    expect(res2.headers.get("X-Found-Via")).toBe("known");
    expect(res2.headers.get("X-Pdf-Url")).toBe(zorbPdfUrl);
  });
});

// ─── isExpansion Bypass ────────────────────────────────────────────────────────

describe("isExpansion bypass", () => {
  // "NEMESIS_VOIDSEEDERS" is an expansion folder: for gameName "Nemesis" the
  // segment contains the base name plus extra words, so isUrlForBaseGame
  // rejects it. Only isExpansion=true can get it through.
  const expansionUrl = "https://example.com/NEMESIS_VOIDSEEDERS/ENG/rulebook.pdf";

  it("accepts an expansion folder URL that would fail the base-game check (Strategy 3)", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: expansionUrl }] } })],
      ["/NEMESIS_VOIDSEEDERS/ENG/rulebook.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Nemesis", isExpansion: true, publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(expansionUrl);
  });

  it("rejects the same expansion URL when isExpansion is not set", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: expansionUrl }] } })],
      ["/NEMESIS_VOIDSEEDERS/ENG/rulebook.pdf", pdfResponse], // would be a valid PDF if the check allowed it
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Nemesis", publisherName: "Some Publisher" });

    expect(res.status).toBe(404);
    // The base-game check rejected the candidate before any validation fetch.
    expect(mockRequest.mock.calls.some((call) => requestHaystack(call).includes("NEMESIS_VOIDSEEDERS"))).toBe(false);
  });

  it("accepts an expansion filename containing the base game name", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    // "nemesis_voidseeders_rulebook.pdf" starts with the base name plus extra
    // words → isUrlForBaseGame rejects it without the flag.
    const url = "https://example.com/nemesis_voidseeders_rulebook.pdf";
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url }] } })],
      ["/nemesis_voidseeders_rulebook.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Nemesis", isExpansion: true, publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(url);
  });

  it("bypasses validation for cached URLs (Strategy 1)", async () => {
    const cachedUrl = "https://zorb.com/Zorblatt_Exansion/ENG/rules.pdf";
    mockedReadFile.mockResolvedValue(JSON.stringify({ games: { zorblatt: cachedUrl }, publishers: {} }));
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 404, body: "nf" })],
      ["/Zorblatt_Exansion/ENG/rules.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", isExpansion: true });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(cachedUrl);
    expect(res.headers.get("X-Found-Via")).toBe("known");
  });

  it("rejects a cached expansion URL when isExpansion is not set", async () => {
    const cachedUrl = "https://zorb.com/Zorblatt_Exansion/ENG/rules.pdf";
    mockedReadFile.mockResolvedValue(JSON.stringify({ games: { zorblatt: cachedUrl }, publishers: {} }));
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 404, body: "nf" })],
      ["/Zorblatt_Exansion/ENG/rules.pdf", pdfResponse], // would be a valid PDF if the check allowed it
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt" });

    expect(res.status).toBe(404);
    // The cached URL was rejected by the base-game check before any validation fetch.
    expect(mockRequest.mock.calls.some((call) => requestHaystack(call).includes("Zorblatt_Exansion"))).toBe(false);
  });

  it("bypasses validation for probe URLs (Strategy 2)", async () => {
    // A hyphenated name produces a folder ("NemesisLockdown") that no longer
    // matches the normalized game name ("nemesis_lockdown"), so every probe
    // candidate fails isUrlForBaseGame without the flag.
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        games: {},
        publishers: {
          "awaken realms": {
            baseUrl: "https://awakenrealms.com/images/download/",
            domain: "awakenrealms.com",
          },
        },
      })
    );
    const probeUrl = "https://awakenrealms.com/images/download/NemesisLockdown/ENG/rulebook.pdf";
    setHttpRouting([
      ["/images/download/NemesisLockdown/ENG/rulebook.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Nemesis-Lockdown", isExpansion: true, publisherName: "Awaken Realms" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(probeUrl);
    expect(res.headers.get("X-Found-Via")).toBe("probe");
  });

  it("rejects probe URLs when isExpansion is not set", async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        games: {},
        publishers: {
          "awaken realms": {
            baseUrl: "https://awakenrealms.com/images/download/",
            domain: "awakenrealms.com",
          },
        },
      })
    );
    setHttpRouting([["hasbro.com", htmlResponse]]);

    const res = await post({ gameName: "Nemesis-Lockdown", publisherName: "Awaken Realms" });

    expect(res.status).toBe(404);
    // Every probe candidate was rejected by the base-game check before any fetch.
    expect(mockRequest.mock.calls.some((call) => requestHaystack(call).includes("NemesisLockdown"))).toBe(false);
  });
});

// ─── End-to-End Language Filtering ──────────────────────────────────────────────

describe("end-to-end language filtering", () => {
  it("skips English-only PDFs when the user selects 'de' (Strategy 3)", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const enUrl = "https://example.com/zorblatt/ENG/rules.pdf"; // English tag → skipped for "de"
    const deUrl = "https://example.com/zorblatt/GER/rules.pdf"; // German tag → accepted
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: enUrl }, { url: deUrl }] } })],
      ["/zorblatt/ENG/rules.pdf", pdfResponse], // would be a valid PDF if the language matched
      ["/zorblatt/GER/rules.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher", language: "de" });

    expect(res.status).toBe(200);
    // The English candidate is skipped in favor of the German one.
    expect(res.headers.get("X-Pdf-Url")).toBe(deUrl);
  });

  it("skips German-only PDFs when the user selects 'en' (Strategy 3)", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const deUrl = "https://example.com/zorblatt/GER/rules.pdf"; // German tag → rejected for "en"
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: deUrl }] } })],
      ["/zorblatt/GER/rules.pdf", pdfResponse], // would be a valid PDF if the language matched
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher", language: "en" });

    expect(res.status).toBe(404);
  });

  it("allows URLs with no language tag regardless of the selection (Strategy 4)", async () => {
    const homeUrl = "https://publisher.com";
    // No language tag anywhere in the URL → can't determine → allowed.
    const pdfUrl = "https://publisher.com/zorblatt/rules.pdf";
    setHttpRouting([
      ["/zorblatt/rules.pdf", pdfResponse],
      [/^publisher\.com\n\/$/, () => htmlWithLinks([pdfUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: homeUrl, publisherName: "Some Publisher", language: "de" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(pdfUrl);
  });

  it("rejects a mismatched language tag (Strategy 4)", async () => {
    const homeUrl = "https://publisher.com";
    // German-only PDF, but the user asked for English → rejected.
    const deUrl = "https://publisher.com/zorblatt/GER/rules.pdf";
    setHttpRouting([
      ["/zorblatt/GER/rules.pdf", pdfResponse], // would be a valid PDF if the language matched
      [/^publisher\.com\n\/$/, () => htmlWithLinks([deUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: homeUrl, publisherName: "Some Publisher", language: "en" });

    expect(res.status).toBe(404);
  });

  it("falls through to 404 when every candidate is filtered out by language (Strategy 1)", async () => {
    // The cached URL is English-only; with language "de" Strategy 1 rejects it,
    // and no other strategy can surface a German rulebook.
    const cachedUrl = "https://zorb.com/zorblatt/ENG/rules.pdf";
    mockedReadFile.mockResolvedValue(JSON.stringify({ games: { zorblatt: cachedUrl }, publishers: {} }));
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 404, body: "nf" })],
      ["/zorblatt/ENG/rules.pdf", pdfResponse], // would be a valid PDF if the language matched
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", language: "de" });

    expect(res.status).toBe(404);
    // The cached URL was rejected by the language filter before any validation fetch.
    expect(mockRequest.mock.calls.some((call) => requestHaystack(call).includes("zorblatt/ENG"))).toBe(false);
  });

  it("accepts a matching language tag from the cache (Strategy 1)", async () => {
    const cachedUrl = "https://zorb.com/zorblatt/GER/rules.pdf";
    mockedReadFile.mockResolvedValue(JSON.stringify({ games: { zorblatt: cachedUrl }, publishers: {} }));
    setHttpRouting([
      ["wikipedia.org", () => ({ status: 404, body: "nf" })],
      ["/zorblatt/GER/rules.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", language: "de" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(cachedUrl);
    expect(res.headers.get("X-Found-Via")).toBe("known");
  });

  it("never fetches an English URL when the user selects 'de' (Strategy 2)", async () => {
    // With language "de" the probe only builds /GER/ candidates, so an English
    // URL that would be a valid PDF is never even fetched.
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        games: {},
        publishers: { "zorb games": { baseUrl: "https://zorb.com/downloads/", domain: "zorb.com" } },
      })
    );
    const enUrl = "https://zorb.com/downloads/Zorblatt/ENG/rulebook.pdf"; // would be a valid PDF
    setHttpRouting([
      ["/downloads/Zorblatt/ENG/rulebook.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Zorb Games", language: "de" });

    expect(res.status).toBe(404);
    expect(mockRequest.mock.calls.some((call) => requestHaystack(call).includes("/ENG/"))).toBe(false);
  });

  it("accepts the requested language folder from the probe (Strategy 2)", async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        games: {},
        publishers: { "zorb games": { baseUrl: "https://zorb.com/downloads/", domain: "zorb.com" } },
      })
    );
    const deUrl = "https://zorb.com/downloads/Zorblatt/GER/rulebook.pdf";
    setHttpRouting([
      ["/downloads/Zorblatt/GER/rulebook.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Zorb Games", language: "de" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(deUrl);
    expect(res.headers.get("X-Found-Via")).toBe("probe");
  });

  it("does not treat 'IT_LIVES' in a filename as an Italian tag", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    // "it" is only the first filename token followed by a non-descriptor word,
    // so detectLanguage must return null — not "it".
    const url = "https://example.com/zorblatt/IT_LIVES.pdf";
    setHttpRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url }] } })],
      ["/zorblatt/IT_LIVES.pdf", pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher", language: "de" });

    // If "it" were falsely detected as Italian, this candidate would be
    // rejected for "de" and the request would 404.
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(url);
  });
});
