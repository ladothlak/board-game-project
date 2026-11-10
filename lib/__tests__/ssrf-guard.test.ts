import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isSafeUrl,
  isPrivateIPv4,
  isPrivateIPv6,
  resolveSafeIp,
  fetchPinned,
  safeFetch,
  SsrfBlockedError,
} from "../fetch-rulebook-utils";
import { createHttpMock } from "./http-mock";

// Mock the DNS module so domain-resolution tests are deterministic and offline.
// The utils module does a default import (`import dns from "dns"`), so we must
// provide `default.promises.lookup`.
const mockLookup = vi.hoisted(() => vi.fn());
vi.mock("dns", () => ({
  default: { promises: { lookup: (...args: unknown[]) => mockLookup(...args) } },
}));

// Mock the http/https modules so fetchPinned never touches a real socket.
// The utils module does default imports (`import http from "http"`), so we
// provide `default.request`. Both protocols share one spy so tests can assert
// on the pinned-IP request options.
const mockRequest = vi.hoisted(() => vi.fn());
vi.mock("http", () => ({
  default: { request: (...args: unknown[]) => mockRequest(...args) },
}));
vi.mock("https", () => ({
  default: { request: (...args: unknown[]) => mockRequest(...args) },
}));

const httpMock = createHttpMock(mockRequest);

beforeEach(() => {
  mockLookup.mockReset();
  mockRequest.mockReset();
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

// ─── resolveSafeIp (DNS resolution + validation, returns the pinned IP) ──────

describe("resolveSafeIp", () => {
  it("passes through a public IPv4 literal (no DNS involved)", async () => {
    await expect(resolveSafeIp("http://93.184.216.34/x")).resolves.toEqual({
      ip: "93.184.216.34",
      hostname: "93.184.216.34",
    });
  });

  it("passes through a public IPv6 literal (brackets stripped)", async () => {
    await expect(resolveSafeIp("http://[2001:db8::1]:8080/x")).resolves.toEqual({
      ip: "2001:db8::1",
      hostname: "2001:db8::1",
    });
  });

  it("maps localhost to 127.0.0.1 (self-hosted dev/testing)", async () => {
    await expect(resolveSafeIp("http://localhost:3111/")).resolves.toEqual({
      ip: "127.0.0.1",
      hostname: "localhost",
    });
  });

  it("throws SsrfBlockedError for private IPv4 literals", async () => {
    await expect(resolveSafeIp("http://10.0.0.1/")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolveSafeIp("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws SsrfBlockedError for private IPv6 literals", async () => {
    await expect(resolveSafeIp("http://[::1]/")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolveSafeIp("http://[fc00::1]/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("resolves a domain to its first public IPv4 address", async () => {
    mockDns(["93.184.216.34", "151.101.1.1"], []);
    await expect(resolveSafeIp("https://www.hasbro.com/x.pdf")).resolves.toEqual({
      ip: "93.184.216.34",
      hostname: "www.hasbro.com",
    });
  });

  it("prefers IPv4 when both A and AAAA records exist", async () => {
    mockDns(["93.184.216.34"], ["2001:db8::1"]);
    await expect(resolveSafeIp("https://example.com/x.pdf")).resolves.toEqual({
      ip: "93.184.216.34",
      hostname: "example.com",
    });
  });

  it("falls back to the first public IPv6 address when only AAAA exists", async () => {
    mockDns([], ["2001:db8::1"]);
    await expect(resolveSafeIp("https://example.com/x.pdf")).resolves.toEqual({
      ip: "2001:db8::1",
      hostname: "example.com",
    });
  });

  it("throws when ANY resolved record is private (checks all, not just the first)", async () => {
    mockDns(["93.184.216.34", "192.168.0.1"], []);
    await expect(resolveSafeIp("https://evil.com/x.pdf")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws when the IPv6 record is private even if the IPv4 is public", async () => {
    mockDns(["93.184.216.34"], ["fc00::1"]);
    await expect(resolveSafeIp("https://evil.com/x.pdf")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws when DNS resolution fails entirely (no records)", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(resolveSafeIp("https://does-not-exist.example/x.pdf")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws for unparseable URLs", async () => {
    await expect(resolveSafeIp("not a url")).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

// ─── fetchPinned (dials the validated IP with SNI + Host preserved) ───────────

describe("fetchPinned", () => {
  it("returns status, headers and body from the pinned connection", async () => {
    httpMock.queueResponse(201, { "content-type": "text/plain", "x-multi": ["a", "b"] }, "hello");
    const res = await fetchPinned("https://example.com/a/b?q=1", "93.184.216.34", "example.com");
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("x-multi")).toBe("a, b");
    expect(await res.text()).toBe("hello");
  });

  it("dials the IP with SNI + Host set to the original hostname", async () => {
    httpMock.queueResponse(200);
    await fetchPinned("https://example.com/x", "93.184.216.34", "example.com", {
      headers: { "User-Agent": "test" },
    });
    const [options] = mockRequest.mock.calls[0];
    expect(options.hostname).toBe("93.184.216.34"); // TCP goes to the IP
    expect(options.port).toBe(443);
    expect(options.servername).toBe("example.com"); // TLS SNI = original host
    expect(options.headers.Host).toBe("example.com"); // HTTP Host = original host
    expect(options.headers["User-Agent"]).toBe("test"); // caller headers preserved
  });

  it("omits servername for plain HTTP (no TLS)", async () => {
    httpMock.queueResponse(200);
    await fetchPinned("http://example.com/x", "93.184.216.34", "example.com");
    const [options] = mockRequest.mock.calls[0];
    expect(options.port).toBe(80);
    expect(options.servername).toBeUndefined();
  });

  it("writes the request body and uses the given method", async () => {
    httpMock.queueResponse(200);
    await fetchPinned("https://example.com/x", "93.184.216.34", "example.com", {
      method: "POST",
      body: "payload",
    });
    const [options] = mockRequest.mock.calls[0];
    expect(options.method).toBe("POST");
    expect(mockRequest.mock.results[0].value.write).toHaveBeenCalledWith("payload");
  });

  it("rejects when the socket errors", async () => {
    httpMock.queueError(new Error("ECONNREFUSED"));
    await expect(fetchPinned("https://example.com/x", "93.184.216.34", "example.com")).rejects.toThrow(
      "ECONNREFUSED"
    );
  });

  it("rejects immediately for an already-aborted signal without connecting", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchPinned("https://example.com/x", "93.184.216.34", "example.com", { signal: controller.signal })
    ).rejects.toBeInstanceOf(DOMException);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("throws for unsupported protocols", async () => {
    await expect(fetchPinned("ftp://example.com/x", "93.184.216.34", "example.com")).rejects.toThrow(
      "Unsupported protocol"
    );
  });
});

// ─── safeFetch (guard + IP pinning + redirect handling) ───────────────────────

describe("safeFetch", () => {
  it("throws SsrfBlockedError for a blocked URL and never touches the network", async () => {
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("throws SsrfBlockedError (correct error type) for a private URL", async () => {
    await expect(safeFetch("http://10.0.0.1/admin")).rejects.toMatchObject({ name: "SsrfBlockedError" });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("blocks http://0.0.0.0/ (empirically routes to loopback on this host)", async () => {
    await expect(safeFetch("http://0.0.0.0:8080/")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("rejects a domain whose DNS resolution fails (fail closed)", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(safeFetch("https://does-not-exist.example/x.pdf")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("pins the connection to the resolved IP with SNI + Host set to the original hostname", async () => {
    mockDns(["93.184.216.34"], []);
    httpMock.queueResponse(200, {}, "ok");
    const res = await safeFetch("https://public.example.com/start");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const [options] = mockRequest.mock.calls[0];
    // TCP connection goes to the validated IP — no DNS re-resolution (TOCTOU fix).
    expect(options.hostname).toBe("93.184.216.34");
    expect(options.port).toBe(443);
    // TLS SNI + HTTP Host preserve the original hostname for cert/vhost selection.
    expect(options.servername).toBe("public.example.com");
    expect(options.headers.Host).toBe("public.example.com");
  });

  it("allows [::ffff:127.0.0.1] (IPv4-mapped form of the allowed loopback)", async () => {
    httpMock.queueResponse(200, {}, "ok");
    const res = await safeFetch("http://[::ffff:127.0.0.1]:8080/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("allows localhost (pinned to 127.0.0.1)", async () => {
    httpMock.queueResponse(200, {}, "ok");
    const res = await safeFetch("http://localhost:3111/");
    expect(res.status).toBe(200);
    expect(mockRequest.mock.calls[0][0].hostname).toBe("127.0.0.1");
  });

  it("blocks a 302 redirect to a private address (redirect-following bypass)", async () => {
    httpMock.queueResponse(302, { location: "http://169.254.169.254/latest/meta-data/" });
    await expect(safeFetch("http://93.184.216.34/")).rejects.toBeInstanceOf(SsrfBlockedError);
    // Only the initial (public) hop is fetched; the internal Location is never touched.
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("follows a valid redirect chain to a public URL (each hop re-resolved + pinned)", async () => {
    mockDns(["93.184.216.34"], []);
    httpMock.queueResponse(302, { location: "https://public.example.com/next" });
    httpMock.queueResponse(200, {}, "final");
    const res = await safeFetch("https://public.example.com/start");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("final");
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("resolves a relative Location header against the current URL", async () => {
    httpMock.queueResponse(302, { location: "/next" });
    httpMock.queueResponse(200);
    await safeFetch("http://93.184.216.34/start");
    const [options] = mockRequest.mock.calls[1];
    expect(options.path).toBe("/next");
  });

  it("throws when a redirect has no Location header", async () => {
    httpMock.queueResponse(302);
    await expect(safeFetch("http://93.184.216.34/")).rejects.toThrow("Redirect with no Location header");
  });

  it("throws after too many redirects", async () => {
    for (let i = 0; i < 6; i++) {
      httpMock.queueResponse(302, { location: `http://93.184.216.34/hop-${i}` });
    }
    await expect(safeFetch("http://93.184.216.34/start")).rejects.toThrow("Too many redirects");
  });
});
