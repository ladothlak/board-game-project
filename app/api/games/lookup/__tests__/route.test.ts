/**
 * Tests for the SSRF guard in the web-search fallback of the lookup route.
 *
 * The web fallback (lookupWeb) follows URLs taken from search results —
 * attacker-influenceable input. Those fetches must go through safeFetch so a
 * malicious result (or a redirect it issues) can never reach an internal
 * address. All external fetches in the route (BGG, Wikipedia, DuckDuckGo and
 * the followed candidate URLs) go through the guard as defense-in-depth;
 * these tests exercise the candidate-following path, where the input is
 * attacker-influenceable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST } from "../route";

vi.mock("@/lib/rate-limit", () => ({
  checkRate: vi.fn(() => ({ allowed: true })),
  getClientIp: vi.fn(() => "test-ip"),
}));
vi.mock("@/lib/audit-log", () => ({
  logRequest: vi.fn(),
}));
// The SSRF guard resolves hostnames via DNS before fetching. In these tests the
// domains are fakes, so resolve every hostname to a public IPv4 address (and no
// AAAA record) so the guard treats them as safe and the fallback runs.
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

// ─── Helpers ────────────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
}

/** Route the mocked fetch by URL substring. Unmatched URLs get a 404. */
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
  return POST(new Request("http://localhost/api/games/lookup", init));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── SSRF guard in the web-search fallback ──────────────────────────────────────

describe("SSRF guard in lookupWeb (web-search fallback)", () => {
  it("skips a search result pointing to a private IP and uses the next candidate", async () => {
    const privateUrl = "http://192.168.1.1/zorblatt";
    const publicUrl = "https://zorblatt.example/zorblatt";
    // The private-IP result comes first, so only the SSRF guard can reject it.
    const searchHtml = `<html><body>` +
      `<a href="${privateUrl}">result</a>` +
      `<a href="${publicUrl}">result</a>` +
      `</body></html>`;
    setFetchRouting([
      ["html.duckduckgo.com", () => htmlResponse(searchHtml)],
      [publicUrl, () => htmlResponse(
        `<title>Zorblatt – Official Rules</title>` +
        `<meta name="description" content="A great game.">`
      )],
    ]);

    const res = await post({ name: "Zorblatt" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("web");
    // The private URL was rejected by the guard; the public candidate was used.
    expect(body.webUrl).toBe(publicUrl);
    // The internal address was never fetched.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("192.168.1.1"))).toBe(false);
  });

  it("rejects a public result that redirects to an internal address", async () => {
    // The attack from the issue: a "publisher" page that 302s to the cloud
    // metadata endpoint. safeFetch must validate the redirect target and stop.
    const publicUrl = "https://zorblatt.example/zorblatt";
    const searchHtml = `<html><body><a href="${publicUrl}">result</a></body></html>`;
    setFetchRouting([
      ["html.duckduckgo.com", () => htmlResponse(searchHtml)],
      [publicUrl, () => new Response("", {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      })],
    ]);

    const res = await post({ name: "Zorblatt" });

    expect(res.status).toBe(404);
    // The redirect target was never fetched.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("169.254.169.254"))).toBe(false);
  });

  it("returns 404 when every candidate is blocked by the SSRF guard", async () => {
    const searchHtml = `<html><body>` +
      `<a href="http://192.168.1.1/zorblatt">result</a>` +
      `<a href="http://10.0.0.5/zorblatt">result</a>` +
      `</body></html>`;
    setFetchRouting([
      ["html.duckduckgo.com", () => htmlResponse(searchHtml)],
    ]);

    const res = await post({ name: "Zorblatt" });

    expect(res.status).toBe(404);
    // No internal address was ever fetched.
    expect(fetchMock.mock.calls.some((c) => /192\.168\.1\.1|10\.0\.0\.5/.test(String(c[0])))).toBe(false);
  });

  it("fetches and extracts metadata from a normal public search result", async () => {
    const publicUrl = "https://zorblatt.example/zorblatt";
    const searchHtml = `<html><body><a href="${publicUrl}">result</a></body></html>`;
    setFetchRouting([
      ["html.duckduckgo.com", () => htmlResponse(searchHtml)],
      [publicUrl, () => htmlResponse(
        `<title>Zorblatt – Official Rules</title>` +
        `<meta name="description" content="Play with 2 to 4 players for 60 minutes.">`
      )],
    ]);

    const res = await post({ name: "Zorblatt" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("web");
    expect(body.webUrl).toBe(publicUrl);
    expect(body.title).toBe("Zorblatt – Official Rules");
  });
});
