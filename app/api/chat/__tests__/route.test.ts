/**
 * Route-level tests for the per-stage latency audit fields in /api/chat
 * (issue #55).
 *
 * The lib-level tests (lib/__tests__/rag-pipeline.test.ts) verify that
 * buildRagContext threads its timings out; these tests verify that the route
 * actually writes them into the audit line: `stages` (expandMs/retrieveMs/
 * rerankMs, spread from the RAG context), `prewarmHit`, and `firstTokenMs`
 * (present only when tokens streamed). The LLM fetch and buildRagContext are
 * mocked, so nothing touches the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST } from "../route";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { getGame } from "@/lib/games";
import { buildRagContext } from "@/lib/rag";
import { getPrewarm } from "../prewarm/route";
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
// returns a deterministic context with known per-stage timings.
vi.mock("@/lib/rag", () => ({
  buildRagContext: vi.fn(),
}));
// The prewarm cache is module state in the prewarm route; mock the lookup so
// hit/miss is controlled per test.
vi.mock("../prewarm/route", () => ({
  getPrewarm: vi.fn(() => null),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SLUG = "test-game";

const GAME = { slug: SLUG, title: "Test Game", description: "A test game." };

/** Deterministic RAG context with known per-stage timings (issue #55). */
const RAG_CONTEXT = {
  excerpts: "--- Page 3 ---\nYou win when all enemies are destroyed.",
  toc: "p. 3: Victory condition.",
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
