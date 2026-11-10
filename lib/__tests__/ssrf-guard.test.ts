import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isSafeUrl, isPrivateIPv4, isPrivateIPv6, safeFetch, SsrfBlockedError } from "../fetch-rulebook-utils";

// Mock the DNS module so domain-resolution tests are deterministic and offline.
// The utils module does a default import (`import dns from "dns"`), so we must
// provide `default.promises.lookup`.
const mockLookup = vi.hoisted(() => vi.fn());
vi.mock("dns", () => ({
  default: { promises: { lookup: (...args: unknown[]) => mockLookup(...args) } },
}));

beforeEach(() => {
  mockLookup.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Make dns.promises.lookup return the given A and AAAA address lists. */
function mockDns(aRecords: string[], aaaaRecords: string[]) {
  mockLookup.mockImplementation((_host: string, opts: { family: number }) => {
    const records = (opts.family === 4 ? aRecords : aaaaRecords).map((address) => ({
      address,
      family: opts.family,
    }));
    return Promise.resolve(records);
  });
}

// ─── isPrivateIPv4 ────────────────────────────────────────────────────────────

describe("isPrivateIPv4", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["169.254.169.254", true], // cloud metadata endpoint
    ["127.0.0.2", true],       // loopback (not the allowed 127.0.0.1)
    ["127.1.2.3", true],
    ["0.0.0.0", true],         // "this network" — empirically routes to loopback
    ["0.255.1.2", true],       // rest of 0.0.0.0/8
  ])("blocks private %s", (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected);
  });

  it.each([
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["93.184.216.34", false],
    ["172.15.0.1", false],  // just outside 172.16/12
    ["172.32.0.1", false],  // just outside 172.16/12
    ["127.0.0.1", false],   // allowed for self-hosted dev/testing
  ])("allows public %s", (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected);
  });

  it("fails closed on malformed input", () => {
    expect(isPrivateIPv4("not.an.ip")).toBe(true);
    expect(isPrivateIPv4("999.0.0.1")).toBe(true);
  });
});

// ─── isPrivateIPv6 ────────────────────────────────────────────────────────────

describe("isPrivateIPv6", () => {
  it.each([
    ["::1", true],                       // loopback
    ["fc00::1", true],                    // unique local
    ["fd12:3456:789a::1", true],          // unique local (fd prefix)
    ["::ffff:10.0.0.1", true],            // IPv4-mapped private (dotted form)
    ["::ffff:192.168.1.1", true],         // IPv4-mapped private
    ["::ffff:a00:1", true],               // IPv4-mapped 10.0.0.1 (hex form)
    ["fe80::1", true],                     // link-local
    ["febf:abcd::1", true],                // top of fe80::/10
    ["fe80::1%eth0", true],                // link-local with zone id
  ])("blocks %s", (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });

  it.each([
    ["2001:db8::1", false],               // public global unicast
    ["::ffff:8.8.8.8", false],            // IPv4-mapped public
    ["::ffff:127.0.0.1", false],          // IPv4-mapped loopback — just 127.0.0.1, which is allowed
    ["fec0::1", false],                   // just outside fe80::/10
    ["2606:4700:4700::1111", false],       // Cloudflare public
  ])("allows %s", (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });

  it("fails closed on malformed input", () => {
    expect(isPrivateIPv6("not-an-ip")).toBe(true);
  });
});

// ─── isSafeUrl: literal IP hosts (no DNS involved) ─────────────────────────────

describe("isSafeUrl — literal IP hosts", () => {
  it.each([
    ["http://169.254.169.254/latest/meta-data/", false], // cloud metadata
    ["http://10.0.0.1/admin", false],
    ["http://192.168.1.1/", false],
    ["http://172.16.0.1/", false],
    ["http://127.0.0.2/", false],            // loopback (not 127.0.0.1)
    ["http://[::1]/", false],                // IPv6 loopback
    ["http://[fc00::1]/", false],            // IPv6 unique local
    ["http://[fe80::1]/", false],            // IPv6 link-local
    ["http://[::ffff:192.168.1.1]/", false],  // IPv4-mapped private
    ["http://0.0.0.0:8080/", false],         // "this network" (routes to loopback)
  ])("rejects %s", async (url, expected) => {
    await expect(isSafeUrl(url)).resolves.toBe(expected);
  });

  it.each([
    ["http://localhost:3111/", true],        // self-hosted dev
    ["http://127.0.0.1:3111/", true],        // self-hosted dev
    ["http://8.8.8.8/", true],               // public
    ["http://[::ffff:8.8.8.8]/", true],      // IPv4-mapped public
  ])("allows %s", async (url, expected) => {
    await expect(isSafeUrl(url)).resolves.toBe(expected);
  });

  it("rejects unparseable URLs", async () => {
    await expect(isSafeUrl("not a url")).resolves.toBe(false);
  });
});

// ─── isSafeUrl: domain names (DNS resolution) ──────────────────────────────────

describe("isSafeUrl — domain names", () => {
  it("allows a domain that resolves to a public IP", async () => {
    mockDns(["93.184.216.34"], []);
    await expect(isSafeUrl("https://www.hasbro.com/x.pdf")).resolves.toBe(true);
  });

  it("rejects a domain that resolves to a private IP", async () => {
    mockDns(["10.0.0.1"], []);
    await expect(isSafeUrl("https://evil.com/x.pdf")).resolves.toBe(false);
  });

  it("rejects a domain that resolves to the cloud metadata IP", async () => {
    mockDns(["169.254.169.254"], []);
    await expect(isSafeUrl("https://evil.com/x.pdf")).resolves.toBe(false);
  });

  it("rejects a domain whose IPv6 record is private even if IPv4 is public", async () => {
    mockDns(["93.184.216.34"], ["fc00::1"]);
    await expect(isSafeUrl("https://evil.com/x.pdf")).resolves.toBe(false);
  });

  it("allows a domain that resolves only to a public IPv6 address", async () => {
    mockDns([], ["2001:db8::1"]);
    await expect(isSafeUrl("https://example.com/x.pdf")).resolves.toBe(true);
  });

  it("checks ALL resolved A records, not just the first", async () => {
    // First record is public, second is private → must reject.
    mockDns(["93.184.216.34", "192.168.0.1"], []);
    await expect(isSafeUrl("https://evil.com/x.pdf")).resolves.toBe(false);
  });

  it("rejects a domain that fails DNS resolution (no records)", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(isSafeUrl("https://does-not-exist.example/x.pdf")).resolves.toBe(false);
  });
});

// ─── safeFetch (guard + redirect handling) ────────────────────────────────────

describe("safeFetch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Recreate the spy each test: the outer afterEach calls vi.restoreAllMocks(),
    // which restores globalThis.fetch to the real implementation.
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function response(status: number, headers: Record<string, string> = {}, body = ""): Response {
    return new Response(body, { status, headers });
  }

  it("throws SsrfBlockedError for a blocked URL and never touches the network", async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error("network must not be touched")));
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws SsrfBlockedError (correct error type) for a private URL", async () => {
    await expect(safeFetch("http://10.0.0.1/admin")).rejects.toMatchObject({ name: "SsrfBlockedError" });
  });

  it("blocks http://0.0.0.0/ (empirically routes to loopback on this host)", async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error("network must not be touched")));
    await expect(safeFetch("http://0.0.0.0:8080/")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows [::ffff:127.0.0.1] (IPv4-mapped form of the allowed loopback)", async () => {
    fetchSpy.mockResolvedValue(response(200, {}, "ok"));
    const res = await safeFetch("http://[::ffff:127.0.0.1]:8080/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("passes redirect: 'manual' to fetch", async () => {
    fetchSpy.mockResolvedValue(response(200));
    await safeFetch("http://93.184.216.34/");
    expect(fetchSpy).toHaveBeenCalledWith("http://93.184.216.34/", expect.objectContaining({ redirect: "manual" }));
  });

  it("blocks a 302 redirect to a private address (redirect-following bypass)", async () => {
    fetchSpy
      .mockResolvedValueOnce(response(302, { location: "http://169.254.169.254/latest/meta-data/" }))
      .mockImplementation(() => Promise.reject(new Error("redirect target must not be fetched")));
    await expect(safeFetch("http://93.184.216.34/")).rejects.toBeInstanceOf(SsrfBlockedError);
    // Only the initial (public) hop is fetched; the internal Location is never touched.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("follows a valid redirect chain to a public URL", async () => {
    mockDns(["93.184.216.34"], []);
    fetchSpy
      .mockResolvedValueOnce(response(302, { location: "https://public.example.com/next" }))
      .mockResolvedValueOnce(response(200, {}, "final"));
    const res = await safeFetch("https://public.example.com/start");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("final");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("resolves a relative Location header against the current URL", async () => {
    fetchSpy
      .mockResolvedValueOnce(response(302, { location: "/next" }))
      .mockResolvedValueOnce(response(200));
    await safeFetch("http://93.184.216.34/start");
    expect(fetchSpy).toHaveBeenLastCalledWith("http://93.184.216.34/next", expect.anything());
  });

  it("throws when a redirect has no Location header", async () => {
    fetchSpy.mockResolvedValueOnce(response(302));
    await expect(safeFetch("http://93.184.216.34/")).rejects.toThrow("Redirect with no Location header");
  });

  it("throws after too many redirects", async () => {
    for (let i = 0; i < 6; i++) {
      fetchSpy.mockResolvedValueOnce(response(302, { location: `http://93.184.216.34/hop-${i}` }));
    }
    await expect(safeFetch("http://93.184.216.34/start")).rejects.toThrow("Too many redirects");
  });
});
