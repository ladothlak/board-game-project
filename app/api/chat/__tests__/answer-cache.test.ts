/**
 * Route-level tests for the final-answer cache in /api/chat (issue #56).
 *
 * The answer cache stores successful answers keyed by slug + normalized
 * question, and is invalidated when the search index mtime changes. These
 * tests verify: a repeat question is replayed with zero LLM calls through
 * the existing SSE protocol (one token event + done with citations) and is
 * audited with answerCacheHit: true; a miss flows through the normal pipeline
 * and caches its result; an advanced index mtime invalidates the entry; and
 * the "ran out of room" fallback answer is never cached. buildRagContext,
 * global fetch, getPrewarm, getGame, rate limit, logRequest, and indexMtime
 * are all mocked, so nothing touches the network or disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST } from "../route";
import { resetAnswerCacheForTest } from "../answer-cache";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { getGame } from "@/lib/games";
import { buildRagContext } from "@/lib/rag";
import { getPrewarm } from "../prewarm/route";
import { indexMtime } from "@/lib/retrieve";

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
// The RAG pipeline is the unit under test's dependency — mock it so misses
// return a deterministic context.
vi.mock("@/lib/rag", () => ({
  buildRagContext: vi.fn(),
}));
// The prewarm cache is module state in the prewarm route; mock the lookup so
// hit/miss is controlled per test.
vi.mock("../prewarm/route", () => ({
  getPrewarm: vi.fn(() => null),
}));
// The answer cache keys its generation off the index mtime (issue #56); mock
// it so tests can advance the index deterministically without touching disk.
vi.mock("@/lib/retrieve", () => ({
  loadIndex: vi.fn(),
  retrieve: vi.fn(),
  docFreqFor: vi.fn(),
  indexMtime: vi.fn(() => 1_000),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SLUG = "test-game";

const GAME = { slug: SLUG, title: "Test Game", description: "A test game." };

/** Deterministic RAG context (the cache-hit path never reaches the pipeline). */
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

/** Parse the SSE frames a response streamed into their JSON objects. */
function sseEvents(text: string): Record<string, unknown>[] {
  return text.split("\n\n")
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => JSON.parse(frame.slice(5)) as Record<string, unknown>);
}

/** All audit entries written so far (logRequest is mocked). */
function auditEntries(): Record<string, unknown>[] {
  return vi.mocked(logRequest).mock.calls.map((c) => c[0] as Record<string, unknown>);
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
  vi.mocked(indexMtime).mockReset().mockReturnValue(1_000);
  // The cache is module state; start every test from a cold cache.
  resetAnswerCacheForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── Cache hits ───────────────────────────────────────────────────────────────

describe("POST /api/chat answer cache (issue #56)", () => {
  it("replays a repeat question from cache with zero LLM calls", async () => {
    // First request: a miss that builds the context and generates the answer.
    mockFetch.mockResolvedValue(sseResponse([
      sseChunk("You win when all"),
      sseChunk(" enemies are destroyed. (p. 3)"),
      "data: [DONE]\n\n",
    ]));
    const first = await post({ slug: SLUG, question: "How do I win?" });
    await first.text();

    // Second identical request: served from the answer cache.
    const second = await post({ slug: SLUG, question: "How do I win?" });
    const text = await second.text();

    // No LLM call for the repeat — the provider was hit exactly once total.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(buildRagContext).toHaveBeenCalledTimes(1);

    // The replay uses the existing SSE protocol: one token event with the full
    // answer, then done with citations.
    expect(sseEvents(text)).toEqual([
      { type: "token", content: "You win when all enemies are destroyed. (p. 3)" },
      { type: "done", citations: [{ page: 3 }] },
    ]);

    // The hit is audited like a normal 200, flagged as an answer-cache hit, with
    // only firstTokenMs known in stages.
    const entry = auditEntries()[1];
    expect(entry.status).toBe(200);
    expect(entry.answerCacheHit).toBe(true);
    expect(entry.stages).toEqual({ firstTokenMs: expect.any(Number) });
  });

  it("flows a miss through the normal pipeline, then hits on the repeat", async () => {
    mockFetch.mockResolvedValue(sseResponse([
      sseChunk("Setup is easy."),
      "data: [DONE]\n\n",
    ]));

    const first = await post({ slug: SLUG, question: "How do I set up the game?" });
    await first.text();
    // The miss ran the full pipeline and was not flagged as a cache hit.
    expect(buildRagContext).toHaveBeenCalledTimes(1);
    expect(auditEntries()[0].answerCacheHit).toBeUndefined();

    const second = await post({ slug: SLUG, question: "How do I set up the game?" });
    const text = await second.text();
    // The repeat was served from cache — the LLM was never called a second time.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const entry = auditEntries()[1];
    expect(entry.answerCacheHit).toBe(true);
    expect(sseEvents(text)).toEqual([
      { type: "token", content: "Setup is easy." },
      { type: "done", citations: [] },
    ]);
  });

  it("invalidates the cache when the search index mtime advances", async () => {
    mockFetch.mockResolvedValue(sseResponse([sseChunk("Answer one."), "data: [DONE]\n\n"]));
    const first = await post({ slug: SLUG, question: "How do I win?" });
    await first.text();

    // A re-digest rewrote the index: the mtime advances and the cached answer
    // is now stale.
    vi.mocked(indexMtime).mockReturnValue(2_000);

    const second = await post({ slug: SLUG, question: "How do I win?" });
    await second.text();

    // The repeat is a miss again — the pipeline and LLM run a second time.
    expect(buildRagContext).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(auditEntries()[1].answerCacheHit).toBeUndefined();
  });

  it("never caches the 'ran out of room' fallback answer", async () => {
    // The provider answers 200 but streams no content deltas at all.
    mockFetch.mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));

    const first = await post({ slug: SLUG, question: "How do I win?" });
    const firstText = await first.text();
    // The model produced no content, so the route falls back — and streams no
    // token events at all.
    expect(firstText).not.toContain("type\":\"token\"");

    const second = await post({ slug: SLUG, question: "How do I win?" });
    await second.text();

    // The fallback was not cached — the repeat re-runs the LLM.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(auditEntries()[1].answerCacheHit).toBeUndefined();
  });
});
