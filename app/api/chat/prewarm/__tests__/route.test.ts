/**
 * Route-level tests for the prewarm fast path and in-flight deduplication
 * (issue #60).
 *
 * The lib-level tests (lib/__tests__/rag-pipeline.test.ts) verify that
 * buildRagContext's fast-path options make zero model calls; these tests
 * verify that the route actually passes them, and that concurrent prewarm
 * requests for the same question share one in-flight build instead of
 * starting a second RAG build. `buildRagContext` is spied on (delegating to
 * the real implementation) so both the options and the resulting fetch
 * behavior are observable; the global fetch is stubbed so nothing touches
 * the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST, getPrewarm, getInflightPrewarm, resetPrewarmStateForTest } from "../route";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { getGame } from "@/lib/games";
import { buildRagContext } from "@/lib/rag";
import { resetRetrieveCachesForTest } from "@/lib/retrieve";

// The route (via buildRagContext → loadIndex) refreshes the index mtime on
// every request, so mock fs/promises as an in-memory stand-in for
// public/search-index.json (same pattern as app/api/chat/__tests__/route.test.ts).
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

// Capture the real buildRagContext so tests can delegate to it through the
// spy: the options the route passes are asserted on the spy, and the real
// pipeline underneath proves the fast path makes no network calls. A mutable
// holder (not a bare const) because vi.mock factories run at import time.
const realRag = vi.hoisted(() => ({ buildRagContext: null as typeof buildRagContext | null }));

vi.mock("@/lib/rag", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/rag");
  realRag.buildRagContext = actual.buildRagContext;
  return { ...actual, buildRagContext: vi.fn() };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRate: vi.fn(() => ({ allowed: true })),
  getClientIp: vi.fn(() => "test-ip"),
}));
vi.mock("@/lib/games", () => ({
  getGame: vi.fn(),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SLUG = "test-game";

const GAME = { slug: SLUG, title: "Test Game", description: "A test game." };

/** A question that passes the guard and is long enough for prewarm (≥ 15 chars). */
const QUESTION = "How do I set up the board for the game?";

/** Deterministic RAG context for the dedup tests (no real pipeline involved). */
const RAG_CONTEXT = {
  excerpts: "--- Page 3 ---\nYou win when all enemies are destroyed.",
  toc: "p. 3: Victory condition.",
  confidence: 0.8,
  pages: [3],
  rankedPages: [3],
  timings: { expandMs: 1, retrieveMs: 2, rerankMs: 0 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

function post(body: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/chat/prewarm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** The fast-path options the route must pass (issue #60). */
const FAST_PATH_OPTIONS = {
  useDecisionModel: false,
  expansionMode: "deterministic",
  skipRerank: true,
};

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  // The route reads the provider key from the environment; auth is disabled so
  // no bearer token is required.
  vi.stubEnv("UNSLOTH_API_KEY", "test-key");
  vi.stubEnv("PARLOR_AUTH_TOKEN", "");
  vi.mocked(checkRate).mockReset().mockReturnValue({ allowed: true });
  vi.mocked(getClientIp).mockReset().mockReturnValue("test-ip");
  vi.mocked(getGame).mockReset().mockResolvedValue(GAME);
  // Delegate the spy to the real pipeline by default; individual tests may
  // override the implementation (the dedup test uses a delayed stub).
  vi.mocked(buildRagContext).mockReset().mockImplementation((...args) => realRag.buildRagContext!(...args));
  // The index file and the retrieve module's mtime cache are per-test
  // fixtures: reset both so every test starts from a cold, known index.
  indexFile.mtimeMs = 1_000;
  indexFile.raw = JSON.stringify({
    entries: [
      { id: "t1", slug: SLUG, title: "Setup", page: 1, text: "Set up the board by placing the tokens." },
      { id: "t3", slug: SLUG, title: "Victory", page: 3, text: "You win when all enemies are destroyed in the game." },
    ],
  });
  resetRetrieveCachesForTest();
  // The prewarm cache and the in-flight map are module state; start every test
  // from a cold, empty pair so earlier builds can't leak into later tests.
  resetPrewarmStateForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── Fast path (issue #60) ─────────────────────────────────────────────────────

describe("POST /api/chat/prewarm fast path", () => {
  it("builds the context with deterministic expansion and no re-rank — zero model calls", async () => {
    // The fetch stub hangs forever: if the fast path made ANY model call
    // (expansion, re-rank, or classification), the build would never settle
    // and this test would time out.
    mockFetch.mockImplementation(() => new Promise<Response>(() => {}));

    const res = await post({ slug: SLUG, question: QUESTION });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "warmed" });
    // No model call was made — prewarm never touches the main model's queue.
    expect(mockFetch).not.toHaveBeenCalled();

    // The route passed the fast-path options to buildRagContext.
    expect(buildRagContext).toHaveBeenCalledTimes(1);
    const [slug, question, apiKey, expansionNames, options] = vi.mocked(buildRagContext).mock.calls[0];
    expect(slug).toBe(SLUG);
    expect(question).toBe(QUESTION);
    expect(apiKey).toBe("test-key");
    expect(options).toEqual(FAST_PATH_OPTIONS);

    // The fast-path context is what the cache stores (hit rate unchanged).
    const cached = getPrewarm(SLUG, QUESTION);
    expect(cached).not.toBeNull();
    expect(cached!.context.length).toBeGreaterThan(0);
  });

  it("returns 'warmed' without building when the question is too short", async () => {
    const res = await post({ slug: SLUG, question: "too short" });
    const body = await res.json();

    expect(body).toEqual({ status: "too_short" });
    expect(buildRagContext).not.toHaveBeenCalled();
  });
});

// ─── In-flight deduplication (issue #60) ───────────────────────────────────────

describe("POST /api/chat/prewarm in-flight deduplication", () => {
  it("shares one in-flight build across concurrent requests for the same question", async () => {
    // A delayed stub so both requests overlap inside the build window.
    vi.mocked(buildRagContext).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(RAG_CONTEXT), 20))
    );

    const [first, second] = await Promise.all([
      post({ slug: SLUG, question: QUESTION }),
      post({ slug: SLUG, question: QUESTION }),
    ]);
    expect(await first.json()).toEqual({ status: "warmed" });
    expect(await second.json()).toEqual({ status: "warmed" });

    // Exactly ONE RAG build for the two concurrent requests.
    expect(buildRagContext).toHaveBeenCalledTimes(1);
  });

  it("exposes the in-flight promise to the chat route via getInflightPrewarm", async () => {
    vi.mocked(buildRagContext).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(RAG_CONTEXT), 20))
    );

    // The prewarm is in flight...
    const pending = post({ slug: SLUG, question: QUESTION });
    // ...give the handler a turn to register its in-flight build (its awaits
    // are microtasks, so one macrotask tick is deterministically enough).
    await new Promise((resolve) => setTimeout(resolve, 0));
    // ...so the lookup finds the in-flight promise for the same key.
    expect(getInflightPrewarm(SLUG, QUESTION)).not.toBeNull();
    // ...and a different question has no in-flight build.
    expect(getInflightPrewarm(SLUG, "A completely different question?")).toBeNull();

    await pending;
    // Once settled, the in-flight entry is gone (the result is now cached).
    expect(getInflightPrewarm(SLUG, QUESTION)).toBeNull();
    expect(getPrewarm(SLUG, QUESTION)).not.toBeNull();
  });

  it("cleans up the in-flight entry when the build fails, so a follow-up starts fresh", async () => {
    vi.mocked(buildRagContext).mockRejectedValue(new Error("prewarm build failed"));

    const res = await post({ slug: SLUG, question: QUESTION });
    expect(await res.json()).toEqual({ status: "error" });

    // The dead in-flight entry is gone...
    expect(getInflightPrewarm(SLUG, QUESTION)).toBeNull();

    // ...and a follow-up request starts a fresh build that succeeds.
    vi.mocked(buildRagContext).mockResolvedValue(RAG_CONTEXT);
    const second = await post({ slug: SLUG, question: QUESTION });
    expect(await second.json()).toEqual({ status: "warmed" });
    expect(buildRagContext).toHaveBeenCalledTimes(2);
  });
});
