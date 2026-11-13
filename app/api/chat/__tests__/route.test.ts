/**
 * Route-level tests for the per-stage latency audit fields in /api/chat
 * (issue #55) and the pre-token stage events (issue #57).
 *
 * The lib-level tests (lib/__tests__/rag-pipeline.test.ts) verify that
 * buildRagContext threads its timings out; these tests verify that the route
 * actually writes them into the audit line: `stages` (expandMs/retrieveMs/
 * rerankMs, spread from the RAG context), `prewarmHit`, and `firstTokenMs`
 * (present only when tokens streamed). They also verify the SSE protocol's
 * additive `{type:"stage"}` events: "retrieving" before any token,
 * "pages-found" with the RAG context's pages, and none on an answer-cache hit.
 * The LLM fetch and buildRagContext are mocked, so nothing touches the
 * network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST } from "../route";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { getGame } from "@/lib/games";
import { buildRagContext, type RagContext } from "@/lib/rag";
import { getPrewarm, getInflightPrewarm } from "../prewarm/route";
import { resetAnswerCacheForTest } from "../answer-cache";
import { resetRetrieveCachesForTest } from "@/lib/retrieve";

// The route refreshes the index mtime before consulting the answer cache
// (issue #56), so `loadIndex()` runs on every request. Mock fs/promises as an
// in-memory stand-in for public/search-index.json (same pattern as
// answer-cache.test.ts) so lib/retrieve runs for real without touching disk.
const indexFile = vi.hoisted(() => ({
  mtimeMs: 1_000,
  raw: JSON.stringify({ entries: [] }),
}));

vi.mock("fs/promises", () => ({
  default: {
    stat: vi.fn(async () => ({ mtimeMs: indexFile.mtimeMs })),
    readFile: vi.fn(async () => indexFile.raw),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRate: vi.fn(() => ({ allowed: true })),
  getClientIp: vi.fn(() => "test-ip"),
}));
vi.mock("@/lib/audit-log", () => ({
  logRequest: vi.fn(),
}));
vi.mock("@/lib/games", () => ({
  getGame: vi.fn(),
}));
// The RAG pipeline is the unit under test's dependency — mock it so the route
// returns a deterministic context with known per-stage timings. Only
// buildRagContext is mocked; detectExplicitPages (issue #61) stays real so the
// max_tokens scaling is exercised against its true behavior.
vi.mock("@/lib/rag", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildRagContext: vi.fn() };
});
// The prewarm cache and the in-flight map are module state in the prewarm
// route; mock both lookups so hit/miss/in-flight is controlled per test.
vi.mock("../prewarm/route", () => ({
  getPrewarm: vi.fn(() => null),
  getInflightPrewarm: vi.fn(() => null),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SLUG = "test-game";

const GAME = { slug: SLUG, title: "Test Game", description: "A test game." };

/** Deterministic RAG context with known per-stage timings (issue #55). */
const RAG_CONTEXT: RagContext = {
  excerpts: "--- Page 3 ---\nYou win when all enemies are destroyed.",
  // Hierarchical-only TOC, as buildRagContext produces it since issue #61
  // dropped the flat one-line-per-page map.
  toc: "Victory / End of Game: p. 3",
  queryType: "specific-rule",
  confidence: 0.8,
  pages: [3],
  rankedPages: [3],
  timings: { expandMs: 12, retrieveMs: 34, rerankMs: 56 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

/** One SSE token frame in the provider's wire format. */
function sseChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** A streaming SSE response made of raw frames (token frames + [DONE]). */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function post(body: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** The single audit entry written by the route (logRequest is mocked). */
function auditEntry(): Record<string, unknown> {
  expect(vi.mocked(logRequest).mock.calls.length).toBe(1);
  return vi.mocked(logRequest).mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  // The route reads the provider key from the environment; auth is disabled so
  // no bearer token is required.
  vi.stubEnv("UNSLOTH_API_KEY", "test-key");
  vi.stubEnv("PARLOR_AUTH_TOKEN", "");
  vi.mocked(checkRate).mockReset().mockReturnValue({ allowed: true });
  vi.mocked(getClientIp).mockReset().mockReturnValue("test-ip");
  vi.mocked(logRequest).mockReset();
  vi.mocked(getGame).mockReset().mockResolvedValue(GAME);
  vi.mocked(buildRagContext).mockReset().mockResolvedValue(RAG_CONTEXT);
  vi.mocked(getPrewarm).mockReset().mockReturnValue(null);
  vi.mocked(getInflightPrewarm).mockReset().mockReturnValue(null);
  // The index file and the retrieve module's mtime cache are per-test
  // fixtures: reset both so every test starts from a cold, known index.
  indexFile.mtimeMs = 1_000;
  indexFile.raw = JSON.stringify({ entries: [] });
  resetRetrieveCachesForTest();
  // The final-answer cache is module state (issue #56); start every test from
  // a cold cache so earlier successes can't be replayed into later failures.
  resetAnswerCacheForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── Audit fields on the 200 path ─────────────────────────────────────────────

describe("POST /api/chat audit line (issue #55)", () => {
  it("logs stages + firstTokenMs when tokens stream (RAG built by this request)", async () => {
    mockFetch.mockResolvedValue(sseResponse([
      sseChunk("Hel"),
      sseChunk("lo there (p. 3)."),
      "data: [DONE]\n\n",
    ]));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    // Consuming the body runs the stream to completion (and the audit log).
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("type\":\"token\"");

    const entry = auditEntry();
    expect(entry.route).toBe("/api/chat");
    expect(entry.status).toBe(200);
    expect(entry.prewarmHit).toBe(false);
    // The RAG stages are spread in verbatim, plus time to first token.
    expect(entry.stages).toEqual({
      expandMs: 12,
      retrieveMs: 34,
      rerankMs: 56,
      firstTokenMs: expect.any(Number),
    });
  });

  it("logs prewarmHit=true and empty RAG stages on a prewarm hit", async () => {
    vi.mocked(getPrewarm).mockReturnValue({
      context: "prewarmed excerpts",
      toc: "p. 1: Setup.",
      confidence: 0.9,
      ts: Date.now(),
    });
    mockFetch.mockResolvedValue(sseResponse([sseChunk("Hi"), "data: [DONE]\n\n"]));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    await res.text();

    // The RAG pipeline never ran for this request.
    expect(buildRagContext).not.toHaveBeenCalled();

    const entry = auditEntry();
    expect(entry.status).toBe(200);
    expect(entry.prewarmHit).toBe(true);
    // A prewarm hit skips the RAG stages, so only firstTokenMs is known.
    expect(entry.stages).toEqual({ firstTokenMs: expect.any(Number) });
  });

  it("omits firstTokenMs when no token ever streamed", async () => {
    // The provider answers 200 but streams no content deltas at all (e.g. the
    // model burned its budget thinking and produced nothing).
    mockFetch.mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    const text = await res.text();

    // The fallback answer is still delivered...
    expect(text).toContain("type\":\"done\"");
    // ...and the audit line carries the RAG stages without firstTokenMs.
    const entry = auditEntry();
    expect(entry.status).toBe(200);
    expect(entry.prewarmHit).toBe(false);
    expect(entry.stages).toEqual({ expandMs: 12, retrieveMs: 34, rerankMs: 56 });
  });
});

// ─── Audit fields on the failure paths ────────────────────────────────────────

describe("POST /api/chat failure audit lines (issue #55)", () => {
  it("logs a 502 audit line when the provider answers with an HTTP error", async () => {
    mockFetch.mockResolvedValue(
      new Response("bad gateway", { status: 502, headers: { "Content-Type": "text/plain" } })
    );

    const res = await post({ slug: SLUG, question: "How do I win?" });
    const text = await res.text();

    // The client still gets an SSE error frame...
    expect(text).toContain("type\":\"error\"");
    // ...and the failure is audited with the RAG stages (no token streamed).
    const entry = auditEntry();
    expect(entry.status).toBe(502);
    expect(entry.prewarmHit).toBe(false);
    expect(entry.stages).toEqual({ expandMs: 12, retrieveMs: 34, rerankMs: 56 });
  });

  it("logs a 502 audit line when the provider is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    const text = await res.text();

    expect(text).toContain("type\":\"error\"");

    const entry = auditEntry();
    expect(entry.status).toBe(502);
    expect(entry.prewarmHit).toBe(false);
    expect(entry.stages).toEqual({ expandMs: 12, retrieveMs: 34, rerankMs: 56 });
  });
});

// ─── Stage events (issue #57) ────────────────────────────────────────────────

describe("POST /api/chat stage events (issue #57)", () => {
  /** Parse the SSE frames out of a streamed response body, in wire order. */
  async function sseEvents(res: Response): Promise<Record<string, unknown>[]> {
    const text = await res.text();
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()));
  }

  it("emits 'retrieving' before any token and 'pages-found' with the context's pages", async () => {
    mockFetch.mockResolvedValue(sseResponse([
      sseChunk("Hello"),
      "data: [DONE]\n\n",
    ]));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    const events = await sseEvents(res);

    // The very first frame is the 'retrieving' stage — sub-second feedback
    // before RAG starts.
    expect(events[0]).toEqual({ type: "stage", stage: "retrieving" });
    // 'pages-found' carries the pages array from the mocked RAG context...
    const pagesFound = events.find((e) => e.type === "stage" && e.stage === "pages-found");
    expect(pagesFound).toEqual({ type: "stage", stage: "pages-found", pages: [3] });
    // ...and arrives before any token.
    const firstToken = events.findIndex((e) => e.type === "token");
    expect(events.indexOf(pagesFound!)).toBeLessThan(firstToken);
  });

  it("emits no stage events on an answer-cache hit", async () => {
    // Prime the final-answer cache with a successful request (issue #56).
    mockFetch.mockResolvedValue(sseResponse([
      sseChunk("You win when all enemies are destroyed."),
      "data: [DONE]\n\n",
    ]));
    const primed = await post({ slug: SLUG, question: "How do I win?" });
    await primed.text();

    // The repeat question replays from cache — no RAG, so no stage events.
    const res = await post({ slug: SLUG, question: "How do I win?" });
    const events = await sseEvents(res);

    expect(events.find((e) => e.type === "stage")).toBeUndefined();
    // The cached answer is still replayed through the existing protocol.
    expect(events.some((e) => e.type === "token")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("emits 'retrieving' but skips 'pages-found' on a prewarm hit", async () => {
    // A prewarm hit has no page list (the cache stores only the context), so
    // the 'pages-found' stage must be skipped — this guards the `if (pages)`
    // check in the route against becoming unconditional.
    vi.mocked(getPrewarm).mockReturnValue({
      context: "prewarmed excerpts",
      toc: "p. 1: Setup.",
      confidence: 0.9,
      ts: Date.now(),
    });
    mockFetch.mockResolvedValue(sseResponse([sseChunk("Hi"), "data: [DONE]\n\n"]));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    const events = await sseEvents(res);

    // 'retrieving' is still the very first frame...
    expect(events[0]).toEqual({ type: "stage", stage: "retrieving" });
    // ...but no 'pages-found' frame appears.
    expect(events.find((e) => e.type === "stage" && e.stage === "pages-found")).toBeUndefined();
  });

  it("skips 'pages-found' when the RAG context has no pages", async () => {
    // An empty index or zero retrieval hits make buildRagContext return
    // `pages: []`. The route must not emit a useless `pages: []` frame — the
    // protocol says 'pages-found' is skipped when pages is empty.
    vi.mocked(buildRagContext).mockResolvedValue({ ...RAG_CONTEXT, pages: [] });
    mockFetch.mockResolvedValue(sseResponse([
      sseChunk("Hello"),
      "data: [DONE]\n\n",
    ]));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    const events = await sseEvents(res);

    // 'retrieving' is still the very first frame...
    expect(events[0]).toEqual({ type: "stage", stage: "retrieving" });
    // ...but no 'pages-found' frame appears for an empty page list.
    expect(events.find((e) => e.type === "stage" && e.stage === "pages-found")).toBeUndefined();
    // Tokens and the final done frame still flow normally.
    expect(events.some((e) => e.type === "token")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});

// ─── In-flight prewarm deduplication (issue #60) ──────────────────────────────
//
// A prewarm for this exact question may still be building its context when the
// real request arrives. The route must await that in-flight promise instead of
// starting a second RAG build — the fast-path context it produces is what the
// prewarm cache stores, so it stands in for a prewarm hit.

describe("POST /api/chat in-flight prewarm deduplication (issue #60)", () => {
  it("awaits an in-flight prewarm promise instead of building a second context", async () => {
    // A prewarm for this question is in flight: its promise resolves after a
    // small real delay with the fast-path RAG context.
    vi.mocked(getInflightPrewarm).mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve(RAG_CONTEXT), 10))
    );
    mockFetch.mockResolvedValue(sseResponse([sseChunk("Hi"), "data: [DONE]\n\n"]));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    const text = await res.text();

    // No second RAG build was started for this request...
    expect(buildRagContext).not.toHaveBeenCalled();
    // ...and the awaited context's pages drive the 'pages-found' stage event.
    expect(text).toContain("type\":\"stage\"");
    expect(text).toContain("pages\":[3]");

    const entry = auditEntry();
    expect(entry.status).toBe(200);
    // The context came from prewarm, so it is audited like a prewarm hit:
    // prewarmHit=true and no RAG stage durations (this request didn't build).
    expect(entry.prewarmHit).toBe(true);
    expect(entry.stages).toEqual({ firstTokenMs: expect.any(Number) });
  });

  it("builds its own context when no in-flight prewarm exists", async () => {
    // getInflightPrewarm returns null (the beforeEach default): the route
    // falls through to buildRagContext exactly as before.
    mockFetch.mockResolvedValue(sseResponse([sseChunk("Hi"), "data: [DONE]\n\n"]));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    await res.text();

    expect(buildRagContext).toHaveBeenCalledTimes(1);
  });

  it("builds its own context when the in-flight prewarm rejects (no 502)", async () => {
    // The in-flight prewarm build failed: the route must fall back to
    // building this request's own context instead of failing the whole
    // request with a misleading provider error.
    vi.mocked(getInflightPrewarm).mockReturnValue(
      Promise.reject(new Error("prewarm build failed"))
    );
    mockFetch.mockResolvedValue(sseResponse([sseChunk("Hi"), "data: [DONE]\n\n"]));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    const text = await res.text();

    // The request succeeded by building its own context...
    expect(buildRagContext).toHaveBeenCalledTimes(1);
    // ...and streamed tokens plus the done frame — no error frame.
    expect(text).toContain("type\":\"token\"");
    expect(text).toContain("type\":\"done\"");
    expect(text).not.toContain("type\":\"error\"");

    const entry = auditEntry();
    expect(entry.status).toBe(200);
    // The prewarm never materialized, so the audit line is a non-hit with
    // the RAG stage durations from this request's own build.
    expect(entry.prewarmHit).toBe(false);
    expect(entry.stages).toEqual({
      expandMs: 12,
      retrieveMs: 34,
      rerankMs: 56,
      firstTokenMs: expect.any(Number),
    });
  });
});

// ─── Generation prompt trim (issue #61) ──────────────────────────────────────
//
// The system prompt no longer carries the flat one-line-per-page map (the
// hierarchical TOC covers every page), and max_tokens scales with question
// type: explicit-page questions get a smaller budget. These tests inspect the
// provider request body that mockFetch captures — no live network involved.

describe("POST /api/chat generation prompt trim (issue #61)", () => {
  /** The JSON body the route sent to the provider (mockFetch's last call). */
  function providerBody(): Record<string, unknown> {
    const calls = vi.mocked(mockFetch).mock.calls;
    expect(calls.length).toBe(1);
    return JSON.parse(String(calls[0][1]?.body)) as Record<string, unknown>;
  }

  it("sends max_tokens 1000 for an explicit-page question", async () => {
    mockFetch.mockResolvedValue(sseResponse([sseChunk("Hi"), "data: [DONE]\n\n"]));

    const res = await post({ slug: SLUG, question: "What does page 3 say?" });
    await res.text();

    expect(providerBody().max_tokens).toBe(1000);
  });

  it("sends max_tokens 2000 for a question without an explicit page", async () => {
    mockFetch.mockResolvedValue(sseResponse([sseChunk("Hi"), "data: [DONE]\n\n"]));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    await res.text();

    expect(providerBody().max_tokens).toBe(2000);
  });

  it("carries the hierarchical TOC in the system prompt without the flat page map", async () => {
    mockFetch.mockResolvedValue(sseResponse([sseChunk("Hi"), "data: [DONE]\n\n"]));

    const res = await post({ slug: SLUG, question: "How do I win?" });
    await res.text();

    const body = providerBody();
    const systemMessages = (body.messages as { role: string; content: string }[])
      .filter((m) => m.role === "system")
      .map((m) => m.content);

    // The hierarchical TOC from the RAG context is present in the prompt...
    expect(systemMessages.some((c) => c.includes("Victory / End of Game: p. 3"))).toBe(true);
    // ...and no flat one-line-per-page map line ("p. N: <text>") appears in any
    // system message — the TOC is carried exactly once.
    const flatMapLine = /^p\. \d+: .+$/m;
    for (const content of systemMessages) {
      expect(content.match(flatMapLine)).toBeNull();
    }
  });
});
