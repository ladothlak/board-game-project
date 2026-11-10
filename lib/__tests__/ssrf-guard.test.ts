import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isSafeUrl, isPrivateIPv4, isPrivateIPv6 } from "../fetch-rulebook-utils";

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
    ["0.0.0.0", false],     // unspecified — not in a blocked range
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
  ])("blocks %s", (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });

  it.each([
    ["2001:db8::1", false],               // public global unicast
    ["::ffff:8.8.8.8", false],            // IPv4-mapped public
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
    ["http://[::ffff:192.168.1.1]/", false],  // IPv4-mapped private
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
