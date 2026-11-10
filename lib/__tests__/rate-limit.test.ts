import { describe, it, expect } from "vitest";
import { checkRate, getClientIp } from "@/lib/rate-limit";

function makeRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/chat", { headers });
}

describe("getClientIp", () => {
  it("returns a fixed identifier for direct connections even when x-forwarded-for is set", () => {
    // The whole point of the fix: a client cannot rotate its own "IP"
    // by setting x-forwarded-for on each request.
    expect(getClientIp(makeRequest({ "x-forwarded-for": "1.2.3.4" }))).toBe("direct");
    expect(getClientIp(makeRequest({ "x-forwarded-for": "5.6.7.8" }))).toBe("direct");
  });

  it("does not trust x-real-ip on direct connections", () => {
    expect(getClientIp(makeRequest({ "x-real-ip": "9.9.9.9" }))).toBe("direct");
  });

  it("returns the fixed identifier when no IP headers are present at all", () => {
    expect(getClientIp(makeRequest())).toBe("direct");
  });

  it("uses x-forwarded-for only when a trusted proxy indicator is present", () => {
    const req = makeRequest({
      "x-request-id": "abc123",
      "x-forwarded-for": "10.0.0.1",
    });
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("takes the leftmost (original client) entry of a comma-separated x-forwarded-for", () => {
    const req = makeRequest({
      "x-request-id": "abc123",
      "x-forwarded-for": "10.0.0.1, 172.16.0.1, 192.168.0.1",
    });
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("falls back to the fixed identifier when behind a proxy but x-forwarded-for is missing", () => {
    const req = makeRequest({ "x-request-id": "abc123" });
    expect(getClientIp(req)).toBe("direct");
  });
});

describe("checkRate", () => {
  it("allows requests up to the limit and blocks beyond it", () => {
    const route = "/api/test/budget-a";
    for (let i = 0; i < 3; i++) {
      expect(checkRate("1.1.1.1", route, 3, 60_000).allowed).toBe(true);
    }
    const blocked = checkRate("1.1.1.1", route, 3, 60_000);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfter).toBeGreaterThan(0);
      expect(blocked.retryAfter).toBeLessThanOrEqual(60);
    }
  });

  it("keeps separate budgets per route", () => {
    const ip = "2.2.2.2";
    expect(checkRate(ip, "/api/test/budget-b", 1, 60_000).allowed).toBe(true);
    expect(checkRate(ip, "/api/test/budget-b", 1, 60_000).allowed).toBe(false);
    // A different route for the same client still has budget.
    expect(checkRate(ip, "/api/test/budget-c", 1, 60_000).allowed).toBe(true);
  });

  it("keeps separate budgets per client identifier", () => {
    const route = "/api/test/budget-d";
    expect(checkRate("client-a", route, 1, 60_000).allowed).toBe(true);
    expect(checkRate("client-a", route, 1, 60_000).allowed).toBe(false);
    expect(checkRate("client-b", route, 1, 60_000).allowed).toBe(true);
  });
});
