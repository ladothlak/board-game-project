import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRagContext, estimateConfidence, HYBRID_CONFIDENCE_THRESHOLD } from "../rag";
import { loadIndex, resetRetrieveCachesForTest } from "../retrieve";
import type { Chunk } from "../retrieve";

// ─── Mocks ──────────────────────────────────────────────────────────────────────
//
// Unit tests for the hybrid configuration (issue #59): the decision-model
// pipeline by default, falling back to the full LLM pipeline when the
// decision-model result's confidence drops below HYBRID_CONFIDENCE_THRESHOLD.
//
// The hybrid logic lives INSIDE buildRagContext and calls itself recursively
// with `useHybrid` stripped, so it cannot be mocked from outside. These tests
// therefore drive the real function with its leaf dependencies mocked
// (loadIndex + fetch) and assert on observable behavior: which endpoints were
// contacted, how many times, and whether the result equals a direct single-arm
// run. The fixtures reuse the score-pinned cases from rag-pipeline.test.ts so
// the confidence outcomes are deterministic in CI.

vi.mock("../retrieve", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, loadIndex: vi.fn() };
});

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  // The mocked loadIndex never advances the real mtime, so reset the
  // module-level DF cache — otherwise the first test's table would be
  // silently served to every later test.
  resetRetrieveCachesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function llmResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Raw JSON response (the decision model returns a flat `{ answers }` body). */
function rawJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Serves the decision-model endpoint (URL contains "/systemone") with a
 * classification verdict ("setup", no rephrasing needed) and rejects the main
 * LLM endpoint — in the tests below the LLM must never be contacted, and any
 * unexpected call is caught by the pipeline's own fallbacks while the call
 * count assertions catch it.
 */
function stubDecisionUp() {
  mockFetch.mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/systemone")) {
      return rawJson({
        answers: {
          queryType: { type: "choice", choice: "setup", confidence: 0.7 },
          needsExpansion: { type: "noul", noul: 0.1 },
        },
      });
    }
    return Promise.reject(new Error("unexpected LLM call"));
  });
}

function decisionCalls(): number {
  return mockFetch.mock.calls.filter((c) => String(c[0]).includes("/systemone")).length;
}

function llmExpandCalls(): number {
  return mockFetch.mock.calls.filter(
    (c) => String(c[0]).includes("/chat/completions") && String(c[1]?.body).includes("search phrases")
  ).length;
}

function llmRerankCalls(): number {
  return mockFetch.mock.calls.filter(
    (c) => String(c[0]).includes("/chat/completions") && String(c[1]?.body).includes("Rate each numbered excerpt")
  ).length;
}

// Compare two RagContexts ignoring `timings` — wall-clock durations differ
// between runs and are not part of the behavioral contract.
function withoutTimings<T extends { timings: unknown }>(ctx: T) {
  return { ...ctx, timings: undefined };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────────

const SLUG = "test-game";
const KEY = "test-key";

const CHUNKS: Chunk[] = [
  { id: "t1", slug: SLUG, title: "Setup", page: 1, text: "Set up the board by placing the tokens." },
  { id: "t2", slug: SLUG, title: "Combat", page: 2, text: "Each turn you may attack with your forces." },
  { id: "t3", slug: SLUG, title: "Victory", page: 3, text: "You win when all enemies are destroyed in the game." },
];

// ─── buildRagContext hybrid mode (issue #59) ─────────────────────────────────────

describe("buildRagContext hybrid mode (issue #59)", () => {
  beforeEach(() => {
    vi.mocked(loadIndex).mockResolvedValue(CHUNKS);
  });

  it("pins the tunable confidence threshold", () => {
    expect(HYBRID_CONFIDENCE_THRESHOLD).toBe(0.25);
  });

  it("keeps the decision-model result when confidence is at or above the threshold", async () => {
    // Strong base retrieval: the quality gate passes, so no re-rank is needed
    // in either arm (pinned by rag-pipeline.test.ts — no LLM call, confidence
    // > 0.25 for this fixture). The decision model classifies the question and
    // says no expansion is needed, so the LLM is never contacted at all.
    stubDecisionUp();

    const hybrid = await buildRagContext(
      SLUG,
      "How do I set up the board for the game?",
      KEY,
      undefined,
      { useHybrid: true }
    );

    // The decision-model arm was consulted (its classification call fired)...
    expect(decisionCalls()).toBeGreaterThanOrEqual(1);
    // ...and its result was kept: no fallback to the full pipeline happened, so
    // no LLM expansion / re-rank call was ever made.
    expect(llmExpandCalls()).toBe(0);
    expect(llmRerankCalls()).toBe(0);
    expect(hybrid.confidence).toBeGreaterThanOrEqual(HYBRID_CONFIDENCE_THRESHOLD);

    // The hybrid result IS the decision-model result: run that arm directly and
    // compare (timings excluded — wall clock differs between runs). Re-stub the
    // decision model after the reset so this comparison run exercises the same
    // live decision-model path as arm 1 (a bare reset would leave no fetch
    // implementation, forcing askDecisionModel to throw and fall back to the
    // keyword heuristic — making the equality hold only by coincidence).
    mockFetch.mockReset();
    stubDecisionUp();
    const direct = await buildRagContext(
      SLUG,
      "How do I set up the board for the game?",
      KEY,
      undefined,
      { useDecisionModel: true }
    );
    expect(withoutTimings(hybrid)).toEqual(withoutTimings(direct));
  });

  it("pins the exact-threshold confidence mapping (boundary)", () => {
    // Pins the exact-0.25 boundary the above/below tests leave open. A top
    // retrieval score of EXACTLY 2.5 maps to estimateConfidence = min(1, 2.5/10)
    // = HYBRID_CONFIDENCE_THRESHOLD — neither above nor below it. This is the
    // value the hybrid branch's `confidence < THRESHOLD` test compares against,
    // so pinning the mapping here fixes what "at the threshold" means: the `<`
    // operator keeps the decision-model result (it does not fall back).
    expect(estimateConfidence([{ ...CHUNKS[0], score: 2.5 }])).toBe(HYBRID_CONFIDENCE_THRESHOLD);
    // Just above the boundary stays strictly above it (the keep side), and just
    // below drops strictly below (the fallback side) — the two sides the
    // above/below hybrid tests exercise.
    expect(estimateConfidence([{ ...CHUNKS[0], score: 2.51 }])).toBeGreaterThan(HYBRID_CONFIDENCE_THRESHOLD);
    expect(estimateConfidence([{ ...CHUNKS[0], score: 2.49 }])).toBeLessThan(HYBRID_CONFIDENCE_THRESHOLD);
  });

  it("falls back to the full LLM pipeline when confidence is below the threshold", async () => {
    // Pinned low-confidence fixture (rag-pipeline.test.ts): "How do we win?"
    // only weakly matches the victory chunk (it classifies as a general
    // question, so no section-anchored boost fires), and with every fetch
    // rejected the raw (low) tfidf score carries through — confidence < 0.25.
    // The question is short, so no expansion fires in any arm; each arm makes
    // exactly one LLM re-rank attempt (which fails and falls back to the raw
    // scores).
    mockFetch.mockRejectedValue(new Error("provider down"));

    // Reference: the full pipeline run on its own.
    const direct = await buildRagContext(SLUG, "How do we win?", KEY, undefined, {
      useDecisionModel: false,
      scoring: "tfidf",
    });
    expect(direct.confidence).toBeLessThan(HYBRID_CONFIDENCE_THRESHOLD);
    const directCalls = mockFetch.mock.calls.length; // one LLM re-rank attempt

    // The hybrid run must make the extra decision-model attempts of its first
    // arm AND a second, full-pipeline arm.
    mockFetch.mockReset();
    const hybrid = await buildRagContext(SLUG, "How do we win?", KEY, undefined, {
      useHybrid: true,
      scoring: "tfidf",
    });

    // Arm 1 (decision model) contacted the model for classification AND a
    // re-rank score — both rejected...
    expect(decisionCalls()).toBe(2);
    // ...and fell back to the LLM re-rank internally; arm 2 (full pipeline)
    // made its own LLM re-rank attempt. Two re-rank attempts total proves the
    // fallback arm ran.
    expect(llmRerankCalls()).toBe(2);
    expect(llmExpandCalls()).toBe(0);
    expect(hybrid.confidence).toBeLessThan(HYBRID_CONFIDENCE_THRESHOLD);

    // The returned result IS the full-pipeline result (timings excluded).
    expect(withoutTimings(hybrid)).toEqual(withoutTimings(direct));
    // Sanity: the reference run really was a single-arm run.
    expect(directCalls).toBe(1);
  });

  it("is OFF by default — no options and useHybrid: false behave exactly as before", async () => {
    // One LLM call (the re-rank) per run; no decision-model contact at all.
    mockFetch.mockResolvedValue(llmResponse("[5, 1]"));

    const noOptions = await buildRagContext(SLUG, "How do I win?", KEY);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(decisionCalls()).toBe(0);

    mockFetch.mockReset();
    const explicitOff = await buildRagContext(SLUG, "How do I win?", KEY, undefined, {
      useHybrid: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(decisionCalls()).toBe(0);

    // Identical behavior: same result (timings excluded), same call pattern.
    expect(withoutTimings(explicitOff)).toEqual(withoutTimings(noOptions));
  });

  it("terminates on an empty index without recursing", async () => {
    // An unknown slug makes both inner arms return the early empty context
    // (confidence 0 < threshold, so the fallback arm also runs and returns
    // the same empty context). The recursion must stop after those two calls —
    // if it didn't, this test would hang.
    mockFetch.mockRejectedValue(new Error("down"));
    vi.mocked(loadIndex).mockResolvedValue([]);

    const result = await buildRagContext("other-game", "How do I win?", KEY, undefined, {
      useHybrid: true,
    });

    expect(result).toEqual({
      excerpts: "",
      toc: "",
      queryType: "general",
      confidence: 0,
      pages: [],
      rankedPages: [],
      timings: { expandMs: 0, retrieveMs: 0, rerankMs: 0 },
    });
    // Arm 1 (decision model) fires its classification call before the empty
    // index is detected; the fallback arm makes no calls. The LLM endpoint is
    // never contacted.
    expect(decisionCalls()).toBe(1);
    expect(llmExpandCalls()).toBe(0);
    expect(llmRerankCalls()).toBe(0);
  });
});
