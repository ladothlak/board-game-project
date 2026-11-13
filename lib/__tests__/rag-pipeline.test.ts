import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRagContext, decisionClassify, decisionRerank, expandQuery, expandQueryDeterministic, isEcho } from "../rag";
import { loadIndex, resetRetrieveCachesForTest } from "../retrieve";
import type { Chunk } from "../retrieve";

// ─── Mocks ──────────────────────────────────────────────────────────────────────
//
// Integration tests for the full buildRagContext pipeline. Unlike rag.test.ts
// (which unit-tests each pure function), these tests exercise how the stages
// compose: classification → expansion gating → multi-query retrieval → page /
// expansion boosts → LLM re-ranking → cross-reference following → adaptive
// budget → confidence → hierarchical TOC.
//
// Only loadIndex is mocked, so the real retrieve/pageMap implementations run —
// the tests assert on observable pipeline behavior (what goes in, what comes
// out), not on internal scoring details.

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
 * Deterministic LLM stub that routes on the prompt content: the expansion
 * call asks for "search phrases", the re-ranking call asks to "Rate each
 * numbered excerpt". Expansion variants and rerank scores are configurable
 * per test.
 */
function stubLlm(opts: { expansion?: string[]; rerank?: number[] } = {}) {
  mockFetch.mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    // The re-rank instruction lives in the system prompt, so match across
    // all messages.
    const prompt = body.messages.map((m) => m.content).join("\n");
    if (prompt.includes("search phrases")) {
      return llmResponse(JSON.stringify(opts.expansion ?? ["variant one", "variant two"]));
    }
    if (prompt.includes("Rate each numbered excerpt")) {
      return llmResponse(JSON.stringify(opts.rerank ?? [5, 5]));
    }
    return llmResponse("[]");
  });
}

function expansionCalls(): number {
  return mockFetch.mock.calls.filter((c) => String(c[1]?.body).includes("search phrases")).length;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────────

const SLUG = "test-game";
const KEY = "test-key";

const CHUNKS: Chunk[] = [
  { id: "t1", slug: SLUG, title: "Setup", page: 1, text: "Set up the board by placing the tokens." },
  { id: "t2", slug: SLUG, title: "Combat", page: 2, text: "Each turn you may attack with your forces." },
  { id: "t3", slug: SLUG, title: "Victory", page: 3, text: "You win when all enemies are destroyed in the game." },
];

// ─── buildRagContext (full pipeline) ─────────────────────────────────────────────

describe("buildRagContext", () => {
  beforeEach(() => {
    vi.mocked(loadIndex).mockResolvedValue(CHUNKS);
  });

  it("skips LLM expansion for short queries and retrieves directly", async () => {
    stubLlm();
    const result = await buildRagContext(SLUG, "How do I win?", KEY);

    // Exactly one LLM call: the re-rank. No expansion call is made.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(expansionCalls()).toBe(0);

    // Retrieval still produced a usable context.
    expect(result.excerpts).toContain("--- Page 3 ---");
    expect(result.pages).toContain(3);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("boosts an explicitly referenced page to the top and skips expansion", async () => {
    vi.mocked(loadIndex).mockResolvedValue([
      ...CHUNKS,
      { id: "t42", slug: SLUG, title: "Reference", page: 42, text: "The reference table lists all keywords." },
    ]);
    stubLlm();

    // 21 chars long (would normally trigger expansion), but the explicit
    // page reference gates it off.
    const result = await buildRagContext(SLUG, "Tell me about p. 42", KEY);

    // No LLM calls at all: expansion is gated off by the explicit page
    // reference, and re-ranking is skipped because the referenced page is
    // already boosted to the top.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(expansionCalls()).toBe(0);

    // The referenced page is boosted ahead of everything else.
    expect(result.excerpts.startsWith("--- Page 42 ---")).toBe(true);
    expect(result.pages).toEqual([42]);
    expect(result.confidence).toBe(1);
  });

  it("boosts chunks of a mentioned enabled expansion to the top", async () => {
    vi.mocked(loadIndex).mockResolvedValue([
      ...CHUNKS,
      { id: "g-exp-doom", slug: SLUG, title: "Doom", page: 10, text: "The Doom expansion adds terrifying new enemies.", isExpansion: true },
    ]);
    stubLlm({ expansion: ["doom rules", "expansion enemies"] });

    const result = await buildRagContext(SLUG, "How does the Doom expansion work?", KEY, ["Doom"]);

    // No LLM calls: the base retrieval already has a clear winner (the mentioned
    // expansion chunk matches multiple query terms), so the quality gate passes
    // and expansion is never fired; re-ranking is skipped because the boosted
    // expansion chunk (score 90) is a clear TF-IDF winner.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(expansionCalls()).toBe(0);

    // The expansion chunk (boosted to score 90) leads the context.
    expect(result.excerpts.startsWith("--- Page 10 ---")).toBe(true);
    expect(result.excerpts).toContain("The Doom expansion adds terrifying new enemies.");
    expect(result.confidence).toBe(1);
  });

  it("reports low confidence below the fallback threshold when retrieval is weak and re-ranking fails", async () => {
    mockFetch.mockRejectedValue(new Error("provider down"));

    // "How do I win?" only weakly matches the victory chunk, and with the
    // LLM unavailable the raw (low) score carries through. Pinned to the
    // legacy "tfidf" scorer: under the default BM25 weighting this exact
    // fixture scores 2.537 (confidence 0.254), just above the threshold, so
    // it no longer exercises the low-confidence path. The fallback logic
    // itself is scorer-agnostic (estimateConfidence + the chat route).
    const result = await buildRagContext(SLUG, "How do I win?", KEY, undefined, {
      scoring: "tfidf",
    });

    // Below the 0.25 threshold that makes app/api/chat/route.ts append the
    // low-confidence fallback note to the prompt.
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.25);

    // The weakly-matching chunk is still surfaced so the model has something.
    expect(result.excerpts).toContain("--- Page 3 ---");
    expect(result.pages).toEqual([3]);
  });

  it("returns a full context with high confidence for a strong match", async () => {
    stubLlm({ rerank: [5, 1] });

    const result = await buildRagContext(SLUG, "win the game", KEY);

    // Above the fallback threshold — no fallback note would be appended.
    // (Re-ranking is skipped for this clear TF-IDF winner, so confidence
    // reflects the raw score rather than the LLM-boosted one.)
    expect(result.confidence).toBeGreaterThan(0.25);

    // The top chunk's full text is included (no truncation needed), led by
    // the victory page.
    expect(result.excerpts.startsWith("--- Page 3 ---")).toBe(true);
    expect(result.excerpts).toContain("You win when all enemies are destroyed in the game.");
    expect(result.pages).toEqual([1, 3]);
  });

  it("caps chunks at their allocation and keeps relevant sentences when cutting", async () => {
    const longSetup = `Set up the board. ${"a".repeat(2980)}`; // ~3000 chars
    const longCombat = `${"b".repeat(4900)} set up the board`; // ~5000 chars
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "l1", slug: SLUG, title: "Setup", page: 1, text: longSetup },
      { id: "l2", slug: SLUG, title: "Combat", page: 2, text: longCombat },
    ]);
    stubLlm({ rerank: [5, 5] });

    const result = await buildRagContext(SLUG, "set up the board", KEY);

    // Both pages stay represented...
    expect(result.excerpts).toContain("--- Page 1 ---");
    expect(result.excerpts).toContain("--- Page 2 ---");
    // ...the top chunk is capped at its allocation (no more full-text pass)...
    const page1Part = result.excerpts.split("\n\n")[0].replace("--- Page 1 ---\n", "");
    expect(page1Part.length).toBeLessThan(longSetup.length);
    // ...but the query-relevant sentence survives the cut...
    expect(page1Part).toContain("Set up the board.");
    // ...and the second chunk is truncated to fit its allocation (half the
    // 4000-char budget, since the two chunks score equally).
    const page2Part = result.excerpts.split("\n\n")[1].replace("--- Page 2 ---\n", "");
    expect(page2Part.length).toBeLessThan(longCombat.length);
    expect(page2Part.length).toBeLessThanOrEqual(2000);

    // The whole context stays within the ~4000-char budget plus headers.
    expect(result.excerpts.length).toBeLessThan(4200);
  });

  it("returns a graceful empty context when the slug has no indexed chunks", async () => {
    stubLlm();

    const result = await buildRagContext("other-game", "How do I win?", KEY);

    // No stage ran, so the timings are all zero.
    expect(result).toEqual({
      excerpts: "",
      toc: "",
      confidence: 0,
      pages: [],
      rankedPages: [],
      timings: { expandMs: 0, retrieveMs: 0, rerankMs: 0 },
    });
    // No LLM work is done for a game with no index.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("threads per-stage timings (expandMs, retrieveMs, rerankMs) out for the audit log", async () => {
    stubLlm();

    const result = await buildRagContext(SLUG, "How do I win?", KEY);

    // Tier 0 measurement (issue #55): the chat route writes these into its
    // audit line. Every stage reports a non-negative duration in ms.
    expect(result.timings).toEqual({
      expandMs: expect.any(Number),
      retrieveMs: expect.any(Number),
      rerankMs: expect.any(Number),
    });
    for (const ms of Object.values(result.timings)) {
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports near-zero ms for stages that are gated off", async () => {
    vi.mocked(loadIndex).mockResolvedValue([
      ...CHUNKS,
      { id: "t42", slug: SLUG, title: "Reference", page: 42, text: "The reference table lists all keywords." },
    ]);
    stubLlm();

    // An explicit page reference gates expansion off AND skips the re-rank —
    // so neither stage makes an LLM call. expandMs is exactly 0 (expansion was
    // never fired); rerankMs is tiny (the gate short-circuits before any LLM
    // call, so only clock resolution between two adjacent Date.now() reads).
    const result = await buildRagContext(SLUG, "Tell me about p. 42", KEY);

    expect(result.timings.expandMs).toBe(0);
    expect(result.timings.rerankMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.rerankMs).toBeLessThan(100);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("retrieves and merges results from all expansion query variants", async () => {
    vi.mocked(loadIndex).mockResolvedValue([
      CHUNKS[0],
      { id: "m2", slug: SLUG, title: "Combat", page: 2, text: "Each turn you may attack with your forces." },
      { id: "m4", slug: SLUG, title: "Combat Rules", page: 4, text: "Combat rules: resolve the battle each round." },
    ]);
    stubLlm({ expansion: ["enemy attack", "combat rules"] });

    const result = await buildRagContext(SLUG, "How do I deal with enemy attacks?", KEY);

    // Expansion ran; re-ranking was skipped because the merged TF-IDF
    // winner is clear enough not to need the LLM tie-breaker.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(expansionCalls()).toBe(1);

    // Each variant matched a different page; both made it into the context.
    expect(result.excerpts).toContain("--- Page 2 ---");
    expect(result.excerpts).toContain("--- Page 4 ---");
    expect(result.pages).toEqual([2, 4]);
  });

  it("follows cross-references and includes the referenced page in the final context", async () => {
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "c1", slug: SLUG, title: "Setup", page: 1, text: "Set up the board. See page 3 for the details." },
      { id: "c3", slug: SLUG, title: "Victory", page: 3, text: "Victory condition detailed here." },
    ]);
    stubLlm({ rerank: [5] });

    const result = await buildRagContext(SLUG, "set up the board", KEY);

    // Page 3 is not a direct match for the query — it only enters via the
    // "See page 3" cross-reference in the setup chunk.
    expect(result.excerpts).toContain("--- Page 1 ---");
    expect(result.excerpts).toContain("--- Page 3 ---");
    expect(result.excerpts).toContain("Victory condition detailed here.");
    expect(result.pages).toEqual([1, 3]);
  });

  it("generates a hierarchical TOC combined with the flat page map", async () => {
    stubLlm();

    const result = await buildRagContext(SLUG, "How do I win?", KEY);

    // Hierarchical section lines, one per detected rulebook section.
    expect(result.toc).toContain("Setup: p. 1");
    expect(result.toc).toContain("Game Structure / Turn Order: p. 2");
    expect(result.toc).toContain("Victory / End of Game: p. 3");

    // Flat one-line-per-page map, appended after the sections.
    expect(result.toc).toContain("p. 1: Set up the board by placing the tokens.");
    expect(result.toc).toContain("p. 2: Each turn you may attack with your forces.");
    expect(result.toc).toContain("p. 3: You win when all enemies are destroyed in the game.");

    // Section headers come before the flat map.
    expect(result.toc.indexOf("Setup: p. 1")).toBeLessThan(result.toc.indexOf("p. 1: "));
  });
});

// ─── buildRagContext — retrieve-first (issue #58) ─────────────────────────────
//
// Base retrieval runs first; the expansion is only fired (and awaited) when the
// base result is too weak to trust AND the question needs expansion. These
// tests pin the three behaviors: gate-pass questions never fire the expansion
// (expandMs 0, no LLM call), weak questions fire + await + merge (expandMs > 0),
// and a failing expansion is handled by expandQuery's internal catch (no throw).

describe("buildRagContext — retrieve-first (issue #58)", () => {
  beforeEach(() => {
    vi.mocked(loadIndex).mockResolvedValue(CHUNKS);
  });

  it("does not fire the expansion when base retrieval passes the quality gate", async () => {
    // The expansion LLM call hangs forever: if buildRagContext fired AND
    // awaited it, this test would time out. On a strong base result it must
    // return on the base result alone without ever calling the expansion.
    mockFetch.mockImplementation(() => new Promise<Response>(() => {}));

    const result = await buildRagContext(SLUG, "How do I set up the board for the game?", KEY);

    // Expansion was never fired — we didn't pay for it, so expandMs is 0 and
    // no LLM call was made at all.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(expansionCalls()).toBe(0);
    expect(result.timings.expandMs).toBe(0);

    // The base retrieval result (the setup chunk) carried through to the
    // context, and the clear winner skipped the re-rank.
    expect(result.excerpts.startsWith("--- Page 1 ---")).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.25);
  });

  it("fires and awaits the expansion and merges its variants when base retrieval is weak", async () => {
    // Chunks that only match rephrased variants, not the original question:
    // "with" is the sole base-term hit (a weak score), while "attack" and
    // "combat rules" are reachable only through expansion.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "w1", slug: SLUG, title: "", page: 1, text: "The weather track shifts with the seasons." },
      { id: "a2", slug: SLUG, title: "", page: 2, text: "Each turn you may attack with your forces." },
      { id: "b4", slug: SLUG, title: "", page: 4, text: "Combat rules: resolve the battle each round." },
    ]);
    // The expansion resolves after a real delay so expandMs is measurably > 0.
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(llmResponse(JSON.stringify(["enemy attack", "combat rules"]))), 25)
        )
    );

    const result = await buildRagContext(SLUG, "How do I deal with enemy attacks?", KEY);

    // Expansion was fired + awaited (weak base result) and its variants were
    // merged: page 4 is unreachable from the original question alone.
    expect(expansionCalls()).toBe(1);
    expect(result.timings.expandMs).toBeGreaterThan(0);
    expect(result.excerpts).toContain("--- Page 4 ---");
    expect(result.excerpts).toContain("--- Page 2 ---");

    // The merged winner is clear, so the re-rank was still skipped — exactly
    // one LLM call (the expansion) in total.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("handles a failing expansion gracefully via expandQuery's internal catch", async () => {
    // A weak base result forces the expansion path, but the provider is down:
    // expandQuery catches its own error and falls back to deterministic
    // expansion, so buildRagContext returns normally (no throw). This pins the
    // contract that expansion failures are handled by expandQuery's internal
    // catch — there is no fire-and-forget guard to swallow them.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "w1", slug: SLUG, title: "", page: 1, text: "The weather track shifts with the seasons." },
      { id: "a2", slug: SLUG, title: "", page: 2, text: "Each turn you may attack with your forces." },
    ]);
    mockFetch.mockRejectedValue(new Error("provider down"));

    const result = await buildRagContext(SLUG, "How do I deal with enemy attacks?", KEY);

    // The function returned normally on the deterministic fallback...
    expect(result.excerpts.length).toBeGreaterThan(0);
    // ...and expandMs reflects the (failed) expansion call it awaited.
    expect(result.timings.expandMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── buildRagContext — prewarm fast path (issue #60) ────────────────────────
//
// The prewarm route calls buildRagContext with expansionMode "deterministic"
// and skipRerank true so it never makes a model call. These tests pin both
// halves: a weak base result fires the deterministic expansion (no fetch),
// and a gate failure skips the re-rank entirely (still no fetch). The fetch
// stub hangs forever in each test — if any LLM call were fired and awaited,
// the test would time out.

describe("buildRagContext — prewarm fast path (issue #60)", () => {
  beforeEach(() => {
    vi.mocked(loadIndex).mockResolvedValue(CHUNKS);
  });

  it("uses deterministic expansion without any LLM call when expansionMode is 'deterministic'", async () => {
    // A weak base result (only "with" matches the original question) would
    // normally force the LLM expansion path.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "w1", slug: SLUG, title: "", page: 1, text: "The weather track shifts with the seasons." },
      { id: "a2", slug: SLUG, title: "", page: 2, text: "Each turn you may attack with your forces." },
    ]);
    mockFetch.mockImplementation(() => new Promise<Response>(() => {}));

    const result = await buildRagContext(SLUG, "How do I deal with enemy attacks?", KEY, undefined, {
      expansionMode: "deterministic",
      skipRerank: true,
    });

    // No model call at all — deterministic expansion and the skipped re-rank.
    expect(mockFetch).not.toHaveBeenCalled();
    // The deterministic expansion still ran (weak base result) and produced a
    // usable context.
    expect(result.timings.expandMs).toBeGreaterThanOrEqual(0);
    expect(result.excerpts.length).toBeGreaterThan(0);
  });

  it("skips the re-rank entirely when skipRerank is true, keeping lexical order", async () => {
    // A short query (expansion gated off) whose base result fails the quality
    // gate — the full pipeline would fire the LLM re-rank here.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "v1", slug: SLUG, title: "", page: 1, text: "You win when all enemies are destroyed." },
    ]);
    mockFetch.mockImplementation(() => new Promise<Response>(() => {}));

    const result = await buildRagContext(SLUG, "how do i win", KEY, undefined, { skipRerank: true });

    // No model call at all...
    expect(mockFetch).not.toHaveBeenCalled();
    // ...and the weak candidate still carries through in lexical order.
    expect(result.excerpts).toContain("--- Page 1 ---");
    expect(result.pages).toEqual([1]);
  });
});

// ─── decisionClassify / decisionRerank (direct unit tests) ──────────────────

describe("decisionClassify", () => {
  it("returns the query type and expansion verdict from a choice + noul answer", async () => {
    mockFetch.mockResolvedValue(
      rawJson({
        answers: {
          queryType: { type: "choice", choice: "setup", confidence: 0.6 },
          needsExpansion: { type: "noul", noul: 0.9 },
        },
      })
    );

    const result = await decisionClassify("How do I set up the board?");
    expect(result).toEqual({ queryType: "setup", needsExpansion: true });
  });

  it("defaults an unknown choice to 'general'", async () => {
    mockFetch.mockResolvedValue(
      rawJson({
        answers: {
          queryType: { type: "choice", choice: "nonsense" },
          needsExpansion: { type: "noul", noul: 0.1 },
        },
      })
    );

    const result = await decisionClassify("hello?");
    expect(result).toEqual({ queryType: "general", needsExpansion: false });
  });

  it("returns null when the model is unavailable", async () => {
    mockFetch.mockRejectedValue(new Error("down"));
    await expect(decisionClassify("How do I win?")).resolves.toBeNull();
  });
});

describe("decisionRerank", () => {
  const candidates = [
    { id: "c1", slug: "g", title: "", page: 1, text: "Set up the board.", score: 2 },
    { id: "c2", slug: "g", title: "", page: 2, text: "You win when all enemies are destroyed.", score: 8 },
  ];

  it("reorders candidates by decision-model score combined with TF-IDF", async () => {
    // The model rates c1 (index 0) highly (4) and c2 (index 1) low (1).
    mockFetch.mockResolvedValue(
      rawJson({
        answers: { c0: { type: "score", score: 4 }, c1: { type: "score", score: 1 } },
      })
    );

    const result = await decisionRerank("set up the board", candidates);
    // c1: 2 + 4*3 = 14 beats c2: 8 + 1*3 = 11.
    expect(result![0].id).toBe("c1");
    expect(result![0].score).toBeCloseTo(14);
    expect(result![1].score).toBeCloseTo(11);
  });

  it("returns null when the model is unavailable (so callers fall back to LLM)", async () => {
    mockFetch.mockRejectedValue(new Error("down"));
    await expect(decisionRerank("q", candidates)).resolves.toBeNull();
  });

  it("returns an empty array for no candidates without calling the model", async () => {
    const result = await decisionRerank("q", []);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── buildRagContext with the decision model enabled ────────────────────────

/**
 * Fetch stub that serves BOTH endpoints: the decision model (URL contains
 * "/systemone") and the main LLM (URL contains "/chat/completions"). The
 * decision-model answers are configurable; the LLM is routed on prompt content
 * exactly as in stubLlm.
 */
function stubBoth(opts: {
  queryType?: string;
  needsExpansion?: boolean;
  relevance?: number[];
  expansion?: string[];
} = {}) {
  mockFetch.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/systemone")) {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }> };
      const answers: Record<string, unknown> = {};
      for (const [name, q] of Object.entries(body.questions)) {
        if (q.type === "choice") {
          answers[name] = { type: "choice", choice: opts.queryType ?? "general", confidence: 0.7 };
        } else if (q.type === "noul") {
          answers[name] = { type: "noul", noul: opts.needsExpansion ? 0.9 : 0.1 };
        } else if (q.type === "score") {
          const idx = Object.keys(body.questions).indexOf(name);
          answers[name] = { type: "score", score: opts.relevance?.[idx] ?? 2, confidence: 0.5 };
        }
      }
      return rawJson({ answers });
    }
    // Main LLM endpoint (expansion / re-rank).
    const prompt = (JSON.parse(String(init?.body)).messages as { content: string }[])
      .map((m) => m.content)
      .join("\n");
    if (prompt.includes("search phrases")) {
      return llmResponse(JSON.stringify(opts.expansion ?? ["variant one", "variant two"]));
    }
    if (prompt.includes("Rate each numbered excerpt")) {
      return llmResponse(JSON.stringify("[5, 5]"));
    }
    return llmResponse("[]");
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

describe("buildRagContext with the decision model enabled", () => {
  beforeEach(() => {
    vi.mocked(loadIndex).mockResolvedValue(CHUNKS);
  });

  it("feeds the decision model's query type into the expansion hint", async () => {
    // A weak base result (the chunk doesn't lexically match the original
    // question) forces the expansion path; the decision model says "setup", so
    // the expansion prompt carries the setup-specific hint.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "s2", slug: SLUG, title: "", page: 2, text: "Set up the board by placing the tokens." },
    ]);
    stubBoth({
      queryType: "setup",
      needsExpansion: true,
      expansion: ["set up the board", "placing tokens"],
    });

    const result = await buildRagContext(SLUG, "How do I begin the game?", KEY, undefined, {
      useDecisionModel: true,
    });

    // Expansion ran and its prompt carried the setup-specific hint.
    expect(llmExpandCalls()).toBe(1);
    const expandBody = mockFetch.mock.calls.find(
      (c) => String(c[0]).includes("/chat/completions") && String(c[1]?.body).includes("search phrases")
    )![1]!;
    expect(String(expandBody?.body)).toContain("physical setup");

    // The pipeline still produced a usable context.
    expect(result.excerpts.length).toBeGreaterThan(0);
  });

  it("skips expansion when the decision model says no rephrasing is needed", async () => {
    // Long query would normally expand, but the model says it's a clear lookup.
    stubBoth({ queryType: "specific-rule", needsExpansion: false });

    const result = await buildRagContext(SLUG, "How do I set up the board for the game?", KEY, undefined, {
      useDecisionModel: true,
    });

    // No expansion LLM call was made — the model's verdict gated it off.
    expect(llmExpandCalls()).toBe(0);
    expect(result.excerpts.length).toBeGreaterThan(0);
  });

  it("uses the decision model's score call for re-ranking instead of the LLM", async () => {
    // A query where TF-IDF has no clear winner, so a quality gate is needed.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "r1", slug: SLUG, title: "", page: 1, text: "The board has many tokens and markers." },
      { id: "r2", slug: SLUG, title: "", page: 2, text: "Tokens and markers are placed on the board." },
    ]);
    // The model strongly prefers candidate 0 over candidate 1.
    stubBoth({ relevance: [4, 0] });

    await buildRagContext(SLUG, "where do the tokens go", KEY, undefined, { useDecisionModel: true });

    // A decision-model score call was made for re-ranking...
    const scoreCalls = mockFetch.mock.calls.filter(
      (c) => String(c[0]).includes("/systemone") && String(c[1]?.body).includes("score")
    );
    expect(scoreCalls.length).toBeGreaterThanOrEqual(1);
    // ...and the slow LLM re-rank was NOT made.
    const llmRerankCalls = mockFetch.mock.calls.filter(
      (c) => String(c[0]).includes("/chat/completions") && String(c[1]?.body).includes("Rate each numbered excerpt")
    );
    expect(llmRerankCalls.length).toBe(0);
  });

  it("falls back to keyword classification + LLM re-rank when the model is down", async () => {
    // Decision model unavailable; main LLM works normally. Route by URL so the
    // /systemone call rejects while /chat/completions serves as usual. A weak
    // base result (the chunk doesn't lexically match the original question)
    // forces the expansion path.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "s2", slug: SLUG, title: "", page: 2, text: "Set up the board by placing the tokens." },
    ]);
    mockFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/systemone")) return Promise.reject(new Error("down"));
      const prompt = (JSON.parse(String(init?.body)).messages as { content: string }[])
        .map((m) => m.content)
        .join("\n");
      if (prompt.includes("search phrases")) return llmResponse(JSON.stringify(["set up the board", "placing tokens"]));
      if (prompt.includes("Rate each numbered excerpt")) return llmResponse(JSON.stringify("[5, 5]"));
      return llmResponse("[]");
    });

    // A long query with a weak base result: expansion runs (keyword type) and
    // the context is produced.
    const result = await buildRagContext(SLUG, "How do I begin the game?", KEY, undefined, {
      useDecisionModel: true,
    });

    // Expansion still ran (fallback to keyword classification)...
    expect(llmExpandCalls()).toBe(1);
    // ...and no decision-model call succeeded (all rejected).
    expect(decisionCalls()).toBeGreaterThan(0);
    // ...and the context was produced.
    expect(result.excerpts.length).toBeGreaterThan(0);
  });
});

// ─── expandQueryDeterministic / isEcho (pure, CI-deterministic) ─────────────

describe("expandQueryDeterministic", () => {
  it("produces distinct n-gram phrases for a representative question", () => {
    const result = expandQueryDeterministic("How do I set up the board?");
    // Should produce 2-4 phrases, not just the original question.
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeLessThanOrEqual(4);
    // All phrases should be distinct.
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
    // Should contain 2-word and/or 3-word n-grams from the question.
    expect(result).toContain("set up");
    expect(result).toContain("up the");
  });

  it("applies the synonym map for questions containing known keys", () => {
    const result = expandQueryDeterministic("How do I play the solo version?");
    // The synonym map should add "solo version" and "solo play".
    expect(result).toContain("solo version");
    expect(result).toContain("solo play");
  });

  it("returns [question] for a very short question with no real words", () => {
    const result = expandQueryDeterministic("hi");
    expect(result).toEqual(["hi"]);
  });

  it("produces n-grams that contain at least one real word", () => {
    const result = expandQueryDeterministic("i am in the room");
    // "i am" has no real word (both length <= 2), so it should not appear.
    expect(result).not.toContain("i am");
    // "am in" has no real word, so it should not appear.
    expect(result).not.toContain("am in");
    // "in the" has "the" (length 3 > 2), so it should appear.
    expect(result).toContain("in the");
  });

  it("deduplicates phrases", () => {
    // A question where n-grams and synonyms overlap.
    const result = expandQueryDeterministic("setup the board setup");
    // "set up" from synonym map and "setup the" / "the board" / "board setup"
    // from n-grams should all be present but deduplicated.
    expect(new Set(result).size).toBe(result.length);
  });
});

describe("isEcho", () => {
  it("returns true for a verbatim echo of the question", () => {
    expect(isEcho(["How do I win?"], "How do I win?")).toBe(true);
  });

  it("returns true when all phrases are substrings of the question", () => {
    // Both phrases are contained within the question text.
    expect(isEcho(["how do i", "win"], "How do I win the game?")).toBe(true);
  });

  it("returns false for genuine rephrased variants", () => {
    expect(isEcho(["victory points", "end of game"], "How do I win?")).toBe(false);
  });

  it("returns false when at least one phrase is a genuine variant", () => {
    // One echo, one genuine variant → not an echo overall.
    expect(isEcho(["how do i win", "victory points"], "How do I win?")).toBe(false);
  });

  it("returns true for a near-verbatim echo with minor additions", () => {
    // The phrase contains the question as a substring.
    expect(isEcho(["how do i win the game"], "How do I win?")).toBe(true);
  });

  it("returns false for an empty phrases array", () => {
    expect(isEcho([], "How do I win?")).toBe(false);
  });
});

describe("expandQuery fallback to deterministic expansion", () => {
  it("falls back to deterministic expansion when the LLM throws", async () => {
    mockFetch.mockRejectedValue(new Error("provider down"));
    const result = await expandQuery(KEY, "How do I set up the board for the game?", "setup");
    // Not just [question] — a deterministic n-gram expansion is produced.
    expect(result).not.toEqual(["How do I set up the board for the game?"]);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeLessThanOrEqual(4);
  });

  it("falls back to deterministic expansion when the LLM returns an echo", async () => {
    // The LLM echoes the question verbatim.
    mockFetch.mockResolvedValue(
      llmResponse(JSON.stringify(["How do I set up the board for the game?"]))
    );
    const result = await expandQuery(KEY, "How do I set up the board for the game?", "setup");
    expect(result).not.toEqual(["How do I set up the board for the game?"]);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("returns LLM phrases when they are genuine variants (no fallback)", async () => {
    mockFetch.mockResolvedValue(
      llmResponse(JSON.stringify(["placing tokens", "board setup instructions"]))
    );
    const result = await expandQuery(KEY, "How do I set up the board?", "setup");
    expect(result).toEqual(["placing tokens", "board setup instructions"]);
  });
});
