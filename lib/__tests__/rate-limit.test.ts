import { describe, it, expect } from "vitest";
import { checkRate, getClientIp } from "@/lib/rate-limit";

function makeRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/chat", { headers });
}

describe("getClientIp", () => {
  it("always returns the fixed identifier, regardless of client-set IP headers", () => {
    // The whole point of the fix: a client cannot rotate its own "IP" by
    // setting x-forwarded-for (or any other header) on each request. We read
    // no headers at all, so this is unspoofable by construction.
    expect(getClientIp(makeRequest({ "x-forwarded-for": "1.2.3.4" }))).toBe("direct");
    expect(getClientIp(makeRequest({ "x-forwarded-for": "5.6.7.8" }))).toBe("direct");
  });

  it("does not trust x-real-ip", () => {
    expect(getClientIp(makeRequest({ "x-real-ip": "9.9.9.9" }))).toBe("direct");
  });

  it("returns the fixed identifier when no IP headers are present at all", () => {
    expect(getClientIp(makeRequest())).toBe("direct");
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
