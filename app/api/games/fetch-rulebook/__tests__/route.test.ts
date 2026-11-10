/**
 * Integration-style tests for the rulebook fetch pipeline.
 *
 * Exercises the real POST handler with all external I/O mocked:
 *   - global fetch (PDF validation + downloads)
 *   - fs (persistent known-rulebooks cache)
 *   - rate limiting and audit logging
 *
 * Verifies the strategy cascade: direct URL → Strategy 1 (known URLs) →
 * Strategy 2 (publisher base probe) → Strategy 3 (web search) →
 * Strategy 4 (site scan), with learning persisted when a non-known
 * strategy succeeds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { POST } from "../route";
import { checkRate } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";

vi.mock("@/lib/rate-limit", () => ({
  checkRate: vi.fn(() => ({ allowed: true })),
}));
vi.mock("@/lib/audit-log", () => ({
  logRequest: vi.fn(),
}));
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  writeFileSync: vi.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

function pdfResponse(extra = ""): Response {
  return new Response(new TextEncoder().encode(`%PDF-1.4\n${extra}`), {
    status: 200,
    headers: { "Content-Type": "application/pdf" },
  });
}

function htmlResponse(): Response {
  return new Response("<!DOCTYPE html><html><body>not a pdf</body></html>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** HTML page with plain (unlabeled) links — sufficient for PDF-link extraction. */
function htmlWithLinks(links: string[]): Response {
  const body = links.map((l) => `<a href="${l}">link</a>`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
}

/** HTML page with labeled links — needed for sub-page discovery (label must match rule/download/etc.). */
function htmlWithLabeledLinks(links: Array<{ href: string; label: string }>): Response {
  const body = links.map(({ href, label }) => `<a href="${href}">${label}</a>`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
}

/** Route the mocked fetch by URL substring/regex. Unmatched URLs get a 404. */
function setFetchRouting(routes: Array<[string | RegExp, () => Response]>): void {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    for (const [pattern, makeResponse] of routes) {
      const matches = typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
      if (matches) return Promise.resolve(makeResponse());
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
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

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // No Brave API key → Strategy 3 is skipped deterministically.
  vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
  mockedExistsSync.mockReset().mockReturnValue(false);
  mockedReadFileSync.mockReset().mockImplementation(() => {
    throw new Error("ENOENT");
  });
  mockedWriteFileSync.mockReset();
  vi.mocked(checkRate).mockReset().mockReturnValue({ allowed: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/games/fetch-rulebook", () => {
  it("Strategy 1: serves a static known URL and does not re-persist it", async () => {
    // "Nemesis Lockdown" is in the static KNOWN_RULEBOOK_URLS dict.
    const staticUrl =
      "https://awakenrealms.com/images/download/Nemesis_Lockdown/ENG/Nemesis_LD_Rulebook_280x280mm_bleed3mm-32-pages.pdf";
    setFetchRouting([["Nemesis_LD_Rulebook", pdfResponse]]);

    const res = await post({ gameName: "Nemesis Lockdown" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(staticUrl);
    expect(res.headers.get("X-Found-Via")).toBe("known");
    // "known" findings are not re-persisted (already in the static dict).
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("Cascade: Strategy 1 fails, Strategy 2 (publisher probe) succeeds and learns", async () => {
    // Seed the learned publisher base URL (as if a previous request had learned it).
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
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
    setFetchRouting([["hasbro.com", htmlResponse], [probeUrl, pdfResponse]]);

    const res = await post({ gameName: "Nemesis", publisherName: "Awaken Realms" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(probeUrl);
    expect(res.headers.get("X-Found-Via")).toBe("probe");
    // Non-known findings are persisted for future requests.
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
    const [file, raw] = mockedWriteFileSync.mock.calls[0];
    const data = JSON.parse(String(raw));
    expect(data.games["nemesis"]).toBe(probeUrl);
  });

  it("Direct URL short-circuits all strategies", async () => {
    const directUrl = "https://x.com/Nemesis/ENG/rulebook.pdf";
    setFetchRouting([[directUrl, pdfResponse]]);

    const res = await post({ gameName: "Nemesis", directUrl });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(directUrl);
    expect(res.headers.get("X-Found-Via")).toBe("direct");
  });

  it("Returns 404 when every strategy fails", async () => {
    // No publisher info → autoLookupPublisher is tried (Wikipedia, mocked to fail).
    // Strategy 1: Hasbro pattern candidates serve HTML.
    // Strategy 2: no learned publisher. Strategy 3: no API key. Strategy 4: no publisher URL.
    setFetchRouting([["wikipedia.org", () => new Response("nf", { status: 404 })], ["hasbro.com", htmlResponse]]);

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
    setFetchRouting([[directUrl, () => pdfResponse("hello")]]);

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
    setFetchRouting([[directUrl, () => {
      directCalls++;
      return directCalls === 1 ? pdfResponse() : htmlResponse();
    }]]);
    // …but the download call returns HTML, failing the %PDF sanity check.
    const res = await post({ gameName: "Nemesis", directUrl });

    expect(res.status).toBe(502);
  });
});

// ─── Strategy 3: Targeted Web Search (Brave API) ──────────────────────────────

describe("Strategy 3: webSearchForPdf (Brave Search)", () => {
  it("selects a direct PDF from Brave search results", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const pdfUrl = "https://example.com/zorblatt/rules.pdf";
    setFetchRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: pdfUrl }] } })],
      [pdfUrl, pdfResponse],
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
    setFetchRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: pageUrl }] } })],
      [pdfUrl, pdfResponse],
      [pageUrl, () => htmlWithLinks([pdfUrl])],
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
    setFetchRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: pageUrl }] } })],
      [resolvedDropbox, pdfResponse],
      [pageUrl, () => htmlWithLinks([dropboxUrl])],
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
    setFetchRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: pdfUrl }] } })],
      [pdfUrl, pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher" });

    expect(res.status).toBe(404);
  });

  it("returns null gracefully when the Brave API errors", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    setFetchRouting([
      ["api.search.brave.com", () => new Response("server error", { status: 500 })],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher" });

    expect(res.status).toBe(404);
  });

  it("skips candidates that are in the excluded set", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const excludedUrl = "https://example.com/zorblatt/excluded-rules.pdf";
    const validUrl = "https://example.com/zorblatt/rules.pdf";
    setFetchRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: excludedUrl }, { url: validUrl }] } })],
      [validUrl, pdfResponse],
      [excludedUrl, pdfResponse], // would be valid if not excluded
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
    setFetchRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: enUrl }, { url: frUrl }] } })],
      [enUrl, pdfResponse],
      [frUrl, pdfResponse],
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
    setFetchRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: expansionUrl }] } })],
      [expansionUrl, pdfResponse],
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
    setFetchRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: firstUrl }, { url: secondUrl }] } })],
      [firstUrl, pdfResponse],
      [secondUrl, pdfResponse],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(firstUrl);
  });

  it("returns null when all candidates fail PDF validation", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    const badUrl = "https://example.com/zorblatt/bad.pdf";
    setFetchRouting([
      ["api.search.brave.com", () => jsonResponse({ web: { results: [{ url: badUrl }] } })],
      [badUrl, htmlResponse], // Not a PDF.
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
    setFetchRouting([
      [pdfUrl, pdfResponse],
      [homeUrl, () => htmlWithLinks([pdfUrl])],
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
    setFetchRouting([
      [pdfUrl, pdfResponse],
      [subUrl, () => htmlWithLinks([pdfUrl])],
      [homeUrl, () => htmlWithLabeledLinks([{ href: subUrl, label: "Rules" }])],
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
    setFetchRouting([
      [commonUrl, pdfResponse],
      [homeUrl, () => htmlResponse()],
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
    setFetchRouting([
      [excludedUrl, pdfResponse], // would be valid if not excluded
      [homeUrl, () => htmlWithLinks([excludedUrl])],
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
    setFetchRouting([
      [subUrl, () => new Response("server error", { status: 500 })],
      [homeUrl, () => htmlWithLabeledLinks([{ href: subUrl, label: "Rules" }])],
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
    setFetchRouting([
      [resolvedDropbox, pdfResponse],
      [subUrl, () => htmlWithLinks([dropboxUrl])],
      [homeUrl, () => htmlWithLabeledLinks([{ href: subUrl, label: "Rules" }])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: homeUrl, publisherName: "Some Publisher" });

    expect(res.status).toBe(200);
    // The original (unresolved) Dropbox URL is what gets reported.
    expect(res.headers.get("X-Pdf-Url")).toBe(dropboxUrl);
  });

  it("applies language filtering to homepage candidates", async () => {
    const homeUrl = "https://publisher.com";
    const enUrl = "https://publisher.com/zorblatt/ENG/rules.pdf"; // English tag → rejected for "de"
    const deUrl = "https://publisher.com/zorblatt/GER/rules.pdf"; // German tag → accepted
    setFetchRouting([
      [enUrl, pdfResponse],
      [deUrl, pdfResponse],
      [homeUrl, () => htmlWithLinks([enUrl, deUrl])],
      ["hasbro.com", htmlResponse],
    ]);

    const res = await post({ gameName: "Zorblatt", publisherUrl: homeUrl, publisherName: "Some Publisher", language: "de" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pdf-Url")).toBe(deUrl);
  });
});
