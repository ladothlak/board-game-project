/**
 * Route-level tests for the prewarm head start and in-flight deduplication
 * (issues #60, #67).
 *
 * The lib-level tests (lib/__tests__/rag-pipeline.test.ts) verify that
 * buildPrewarmHeadStart makes zero model calls; these tests verify that the
 * route actually builds a head start (never a final-answer-ready context),
 * caches it marked quality "fast", and that concurrent prewarm requests for
 * the same question share one in-flight build instead of starting a second
 * head-start build. `buildPrewarmHeadStart` is spied on (delegating to the
 * real implementation) so both its arguments and the resulting fetch
 * behavior are observable; the global fetch is stubbed so nothing touches
 * the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST, getPrewarm, getInflightPrewarm, resetPrewarmStateForTest } from "../route";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { getGame } from "@/lib/games";
import { buildPrewarmHeadStart, type PrewarmHeadStart } from "@/lib/rag";
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

// Capture the real buildPrewarmHeadStart so tests can delegate to it through
// the spy: the arguments the route passes are asserted on the spy, and the
// real head-start build underneath proves prewarm makes no network calls. A
// mutable holder (not a bare const) because vi.mock factories run at import
// time.
const realRag = vi.hoisted(() => ({
  buildPrewarmHeadStart: null as typeof buildPrewarmHeadStart | null,
}));

vi.mock("@/lib/rag", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/rag");
  realRag.buildPrewarmHeadStart = actual.buildPrewarmHeadStart;
  return { ...actual, buildPrewarmHeadStart: vi.fn() };
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

/** Deterministic head start for the dedup tests (no real pipeline involved). */
const HEAD_START: PrewarmHeadStart = {
  chunks: [],
  df: undefined,
  lexicalCandidates: [],
  queryType: "setup",
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
  // Delegate the spy to the real head-start build by default; individual
  // tests may override the implementation (the dedup test uses a delayed
  // stub).
  vi.mocked(buildPrewarmHeadStart)
    .mockReset()
    .mockImplementation((...args) => realRag.buildPrewarmHeadStart!(...args));
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

// ─── Head start (issues #60, #67) ─────────────────────────────────────────────

describe("POST /api/chat/prewarm head start", () => {
  it("builds a deterministic head start with zero model calls and caches it as quality 'fast'", async () => {
    // The fetch stub hangs forever: if the head-start build made ANY model
    // call (expansion, re-rank, or classification), the build would never
    // settle and this test would time out.
    mockFetch.mockImplementation(() => new Promise<Response>(() => {}));

    const res = await post({ slug: SLUG, question: QUESTION });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "warmed" });
    // No model call was made — prewarm never touches the main model's queue.
    expect(mockFetch).not.toHaveBeenCalled();

    // The route built a head start via buildPrewarmHeadStart (issue #67).
    expect(buildPrewarmHeadStart).toHaveBeenCalledTimes(1);
    const [slug, question] = vi.mocked(buildPrewarmHeadStart).mock.calls[0];
    expect(slug).toBe(SLUG);
    expect(question).toBe(QUESTION);

    // The cache stores a head start marked "fast" — never a final-answer
    // context (issue #67 rejection rule: the chat route finishes the full
    // pipeline over it before returning).
    const cached = getPrewarm(SLUG, QUESTION);
    expect(cached).not.toBeNull();
    expect(cached!.quality).toBe("fast");
    // The real head-start build produced genuine lexical evidence for this
    // question (the setup chunk matches it), so the head start is usable.
    expect(cached!.headStart.lexicalCandidates.length).toBeGreaterThan(0);
  });

  it("returns 'warmed' without building when the question is too short", async () => {
    const res = await post({ slug: SLUG, question: "too short" });
    const body = await res.json();

    expect(body).toEqual({ status: "too_short" });
    expect(buildPrewarmHeadStart).not.toHaveBeenCalled();
  });
});

// ─── In-flight deduplication (issue #60) ───────────────────────────────────────

describe("POST /api/chat/prewarm in-flight deduplication", () => {
  it("shares one in-flight build across concurrent requests for the same question", async () => {
    // A delayed stub so both requests overlap inside the build window.
    vi.mocked(buildPrewarmHeadStart).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(HEAD_START), 20))
    );

    const [first, second] = await Promise.all([
      post({ slug: SLUG, question: QUESTION }),
      post({ slug: SLUG, question: QUESTION }),
    ]);
    expect(await first.json()).toEqual({ status: "warmed" });
    expect(await second.json()).toEqual({ status: "warmed" });

    // Exactly ONE head-start build for the two concurrent requests.
    expect(buildPrewarmHeadStart).toHaveBeenCalledTimes(1);
  });

  it("exposes the in-flight promise to the chat route via getInflightPrewarm", async () => {
    vi.mocked(buildPrewarmHeadStart).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(HEAD_START), 20))
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
    // Once settled, the in-flight entry is gone (the head start is now cached).
    expect(getInflightPrewarm(SLUG, QUESTION)).toBeNull();
    const cached = getPrewarm(SLUG, QUESTION);
    expect(cached).not.toBeNull();
    // The deduped build's result is cached as a "fast" head start.
    expect(cached!.quality).toBe("fast");
  });

  it("cleans up the in-flight entry when the build fails, so a follow-up starts fresh", async () => {
    vi.mocked(buildPrewarmHeadStart).mockRejectedValue(new Error("prewarm build failed"));

    const res = await post({ slug: SLUG, question: QUESTION });
    expect(await res.json()).toEqual({ status: "error" });

    // The dead in-flight entry is gone...
    expect(getInflightPrewarm(SLUG, QUESTION)).toBeNull();

    // ...and a follow-up request starts a fresh build that succeeds.
    vi.mocked(buildPrewarmHeadStart).mockResolvedValue(HEAD_START);
    const second = await post({ slug: SLUG, question: QUESTION });
    expect(await second.json()).toEqual({ status: "warmed" });
    expect(buildPrewarmHeadStart).toHaveBeenCalledTimes(2);
  });
});
