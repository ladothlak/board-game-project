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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../route";
import { makeFakeRequest } from "@/lib/__tests__/http-mock";

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

function htmlResponse(body: string): { status: number; headers: Record<string, string>; body: string } {
  return { status: 200, headers: { "Content-Type": "text/html" }, body };
}

/**
 * Route the mocked http/https.request by original hostname (preserved in the
 * Host header by fetchPinned) + path. Unmatched requests get a 404.
 */
function setHttpRouting(
  routes: Array<[string | RegExp, () => { status: number; headers?: Record<string, string>; body?: string }]>
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
  mockRequest.mockReset();
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
    setHttpRouting([
      ["html.duckduckgo.com", () => htmlResponse(searchHtml)],
      ["zorblatt.example", () => htmlResponse(
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
    // The internal address was never dialed (requests are pinned to resolved IPs).
    expect(mockRequest.mock.calls.some((c) => c[0].hostname === "192.168.1.1")).toBe(false);
  });

  it("rejects a public result that redirects to an internal address", async () => {
    // The attack from the issue: a "publisher" page that 302s to the cloud
    // metadata endpoint. safeFetch must validate the redirect target and stop.
    const publicUrl = "https://zorblatt.example/zorblatt";
    const searchHtml = `<html><body><a href="${publicUrl}">result</a></body></html>`;
    setHttpRouting([
      ["html.duckduckgo.com", () => htmlResponse(searchHtml)],
      ["zorblatt.example", () => ({
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      })],
    ]);

    const res = await post({ name: "Zorblatt" });

    expect(res.status).toBe(404);
    // The redirect target was never dialed.
    expect(mockRequest.mock.calls.some((c) => c[0].hostname === "169.254.169.254")).toBe(false);
  });

  it("returns 404 when every candidate is blocked by the SSRF guard", async () => {
    const searchHtml = `<html><body>` +
      `<a href="http://192.168.1.1/zorblatt">result</a>` +
      `<a href="http://10.0.0.5/zorblatt">result</a>` +
      `</body></html>`;
    setHttpRouting([
      ["html.duckduckgo.com", () => htmlResponse(searchHtml)],
    ]);

    const res = await post({ name: "Zorblatt" });

    expect(res.status).toBe(404);
    // No internal address was ever dialed.
    expect(mockRequest.mock.calls.some((c) => /192\.168\.1\.1|10\.0\.0\.5/.test(c[0].hostname))).toBe(false);
  });

  it("fetches and extracts metadata from a normal public search result", async () => {
    const publicUrl = "https://zorblatt.example/zorblatt";
    const searchHtml = `<html><body><a href="${publicUrl}">result</a></body></html>`;
    setHttpRouting([
      ["html.duckduckgo.com", () => htmlResponse(searchHtml)],
      ["zorblatt.example", () => htmlResponse(
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
