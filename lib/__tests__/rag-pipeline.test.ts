import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildPrewarmHeadStart, buildRagContext, decisionClassify, decisionRerank, expandQuery, expandQueryDeterministic, finishRagContext, isEcho, measureExcerptDelivery } from "../rag";
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
// Only loadIndex is mocked, so the real retrieve/hierarchicalToc
// implementations run — the tests assert on observable pipeline behavior
// (what goes in, what comes out), not on internal scoring details.

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

  it("fires LLM expansion for short queries with weak retrieval evidence", async () => {
    // "How do I win?" has only two content terms and its top genuine score is
    // below the quality threshold, so the evidence-based gate (issue #68)
    // fires the expansion even though the query is short. The stubbed variants
    // match the victory chunk strongly enough to pass the quality gate, so the
    // re-rank is skipped: exactly one LLM call (the expansion itself).
    stubLlm({ expansion: ["destroy all enemies", "end of the game"] });
    const result = await buildRagContext(SLUG, "How do I win?", KEY);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(expansionCalls()).toBe(1);

    // The expanded queries rescued retrieval: the victory page leads.
    expect(result.excerpts.startsWith("--- Page 3 ---")).toBe(true);
    expect(result.pages).toEqual([1, 3]);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("boosts an explicitly referenced page to the top and skips expansion", async () => {
    vi.mocked(loadIndex).mockResolvedValue([
      ...CHUNKS,
      { id: "t42", slug: SLUG, title: "Reference", page: 42, text: "The reference table lists all keywords." },
    ]);
    stubLlm({ rerank: [5] });

    // 19 chars long (≤ 20), so expansion is gated off by length. The explicit
    // page reference no longer skips the re-rank (issue #65): its bounded prior
    // is correctable by the re-ranker, so the LLM gets a chance to reorder.
    const result = await buildRagContext(SLUG, "Tell me about p. 42", KEY);

    // Exactly one LLM call: the re-rank (expansion is gated off by length).
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(expansionCalls()).toBe(0);

    // The referenced page is boosted ahead of everything else and leads the
    // context. Confidence is 0 because there is NO genuine lexical evidence:
    // no query term matches any chunk, so the only candidate is the boosted
    // page itself (isBoosted: true) and estimateConfidence ignores it
    // (issue #65). A boosted query can never saturate confidence on the
    // strength of its boost alone.
    expect(result.excerpts.startsWith("--- Page 42 ---")).toBe(true);
    expect(result.pages).toContain(42);
    expect(result.confidence).toBe(0);
  });

  it("boosts chunks of a mentioned enabled expansion to the top", async () => {
    vi.mocked(loadIndex).mockResolvedValue([
      ...CHUNKS,
      { id: "g-exp-doom", slug: SLUG, title: "Doom", page: 10, text: "The Doom expansion adds terrifying new enemies.", isExpansion: true },
    ]);
    stubLlm({ expansion: ["doom rules", "expansion enemies"] });

    const result = await buildRagContext(SLUG, "How does the Doom expansion work?", KEY, ["Doom"]);

    // The base retrieval already has a clear winner (the mentioned expansion
    // chunk matches multiple distinctive query terms), so the quality gate
    // passes on the pre-boost lexical list and expansion is never fired.
    // Re-ranking is also skipped (gate passes). No LLM calls at all.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(expansionCalls()).toBe(0);

    // The expansion chunk leads the context (bounded prior keeps it ahead of
    // weaker lexical hits, but the re-rank could correct it if it fired).
    expect(result.excerpts.startsWith("--- Page 10 ---")).toBe(true);
    expect(result.excerpts).toContain("The Doom expansion adds terrifying new enemies.");
    // Confidence is based on genuine (non-boosted) candidates only — the
    // boosted expansion chunk is ignored, so confidence reflects the other
    // chunks' lexical scores (weak), not the boost.
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(1);
  });

  it("reports low confidence below the fallback threshold when retrieval is weak and re-ranking fails", async () => {
    // The victory chunk only weakly matches the query's single distinctive term
    // ("win"), and carries no rulebook wording the deterministic expansion
    // fallback could reach for (the LLM is down), so even after the evidence
    // gate (issue #68) fires the expansion, the top score stays below the
    // quality threshold and the raw (low) score carries through. Pinned to the
    // legacy "tfidf" scorer: under tfidf this fixture scores 1.174 post-expansion
    // (confidence 0.117), below the threshold, so it exercises the
    // low-confidence path. The fallback logic itself is scorer-agnostic
    // (estimateConfidence + the chat route).
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "w1", slug: SLUG, title: "Victory", page: 3, text: "You win when all enemies are destroyed." },
    ]);
    mockFetch.mockRejectedValue(new Error("provider down"));

    const result = await buildRagContext(SLUG, "How do we win?", KEY, undefined, {
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

  it("keeps relevant sentences when cutting and fills truncated pages with spare budget", async () => {
    const longSetup = `Place tokens on the board. ${"a".repeat(7973)}`; // ~8000 chars
    const longCombat = `${"b".repeat(7900)} set up the board`; // ~8000 chars
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "l1", slug: SLUG, title: "Setup", page: 1, text: longSetup },
      { id: "l2", slug: SLUG, title: "Combat", page: 2, text: longCombat },
    ]);
    stubLlm({ rerank: [5, 5] });

    const result = await buildRagContext(SLUG, "set up the board", KEY);

    // Both pages stay represented...
    expect(result.excerpts).toContain("--- Page 1 ---");
    expect(result.excerpts).toContain("--- Page 2 ---");

    // Extract each page's text by its header (order-independent).
    const parts = result.excerpts.split(/\n\n(?=--- Page \d+ ---)/);
    const page1Part = parts.find((p) => p.startsWith("--- Page 1 ---"))!.replace("--- Page 1 ---\n", "");
    const page2Part = parts.find((p) => p.startsWith("--- Page 2 ---"))!.replace("--- Page 2 ---\n", "");

    // ...page 1 is cut to its most query-relevant sentence window — the one
    // sentence that matches the query survives the rest of the filler...
    expect(page1Part).toBe("Place tokens on the board.");
    // ...and pass 2 hands page 1's unused budget to page 2, whose single
    // matching sentence fits the spare cap, so it is delivered in full — a
    // truncated page is never left short while budget remains (issue #64)...
    expect(page2Part).toBe(longCombat);

    // The whole context stays within the ~8000-char budget plus headers.
    expect(result.excerpts.length).toBeLessThan(8200);
  });

  it("returns a graceful empty context when the slug has no indexed chunks", async () => {
    stubLlm();

    const result = await buildRagContext("other-game", "How do I win?", KEY);

    // No stage ran, so the timings are all zero and the query type is the
    // unclassified default.
    expect(result).toEqual({
      excerpts: "",
      toc: "",
      queryType: "general",
      confidence: 0,
      pages: [],
      rankedPages: [],
      excerptedPages: [],
      excerptCoverage: {},
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

  it("reports near-zero ms for expansion and a small rerankMs when only the gate gates", async () => {
    vi.mocked(loadIndex).mockResolvedValue([
      ...CHUNKS,
      { id: "t42", slug: SLUG, title: "Reference", page: 42, text: "The reference table lists all keywords." },
    ]);
    stubLlm();

    // An explicit page reference gates expansion off (length ≤ 20), so
    // expandMs is exactly 0. The re-rank now fires (issue #65: bounded priors
    // are correctable), so rerankMs reflects the LLM call wall-clock.
    const result = await buildRagContext(SLUG, "Tell me about p. 42", KEY);

    expect(result.timings.expandMs).toBe(0);
    expect(result.timings.rerankMs).toBeGreaterThanOrEqual(0);
    // The re-rank fired (one LLM call), so it's no longer near-zero.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retrieves and merges results from all expansion query variants", async () => {
    vi.mocked(loadIndex).mockResolvedValue([
      CHUNKS[0],
      { id: "m2", slug: SLUG, title: "Combat", page: 2, text: "Each turn you may attack with your forces." },
      { id: "m4", slug: SLUG, title: "Combat Rules", page: 4, text: "Combat rules: resolve the battle each round." },
    ]);
    stubLlm({ expansion: ["enemy attack", "combat rules"] });

    const result = await buildRagContext(SLUG, "How do I deal with enemy attacks?", KEY);

    // Expansion ran; the post-expansion genuine lexical evidence is strong
    // enough to pass the quality gate (issue #65), so the re-rank is skipped.
    // Only one LLM call: the expansion itself.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(expansionCalls()).toBe(1);

    // Each variant matched a different page; both made it into the context
    // along with the section-boosted setup page.
    expect(result.excerpts).toContain("--- Page 2 ---");
    expect(result.excerpts).toContain("--- Page 4 ---");
    expect(result.pages).toEqual([1, 2, 4]);
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

  it("generates a hierarchical TOC without the redundant flat page map (issue #61)", async () => {
    stubLlm();

    const result = await buildRagContext(SLUG, "How do I win?", KEY);

    // Hierarchical section lines, one per detected rulebook section — every
    // chunk's page is grouped into a section, so the TOC covers all pages.
    expect(result.toc).toContain("Setup: p. 1");
    expect(result.toc).toContain("Game Structure / Turn Order: p. 2");
    expect(result.toc).toContain("Victory / End of Game: p. 3");

    // The flat one-line-per-page map is no longer included: it was redundant
    // prefill, so the prompt carries the TOC exactly once.
    expect(result.toc).not.toContain("p. 1: Set up the board by placing the tokens.");
    expect(result.toc).not.toContain("p. 2: Each turn you may attack with your forces.");
    expect(result.toc).not.toContain("p. 3: You win when all enemies are destroyed in the game.");

    // The resolved query type is threaded out for per-question budgeting.
    // "How do I win?" classifies as a victory question (the victory type takes
    // precedence over specific-rule in classifyQuery), so that's the type
    // threaded out here.
    expect(result.queryType).toBe("victory");
  });
});

// ─── buildRagContext — excerpt delivery measurement (issue #63) ───────────
//
// excerptedPages / excerptCoverage are derived from the ACTUAL assembled
// context string, so a page that is in `pages` (candidate membership) but not
// in the excerpts can no longer be confused with one the LLM actually saw.

describe("buildRagContext — excerpt delivery measurement (issue #63)", () => {
  beforeEach(() => {
    vi.mocked(loadIndex).mockResolvedValue(CHUNKS);
  });

  it("reports excerptedPages exactly as the pages present in the context string", async () => {
    stubLlm();
    const result = await buildRagContext(SLUG, "How do I win?", KEY);

    // Every page header in the excerpts is reported, and nothing else:
    // excerptedPages is the deduplicated, sorted set of block headers.
    const headers = [...result.excerpts.matchAll(/--- Page (\d+) ---/g)].map((m) => Number(m[1]));
    expect(result.excerptedPages).toEqual([...new Set(headers)].sort((a, b) => a - b));
    // A page is excerpted iff it has a block in the context string.
    for (const p of result.excerptedPages) {
      expect(result.excerpts).toContain(`--- Page ${p} ---`);
    }
  });

  it("reports full coverage (1) when a page's entire text is delivered", async () => {
    // The evidence gate (issue #68) fires the expansion for this short query;
    // the stubbed variants match the victory chunk so the context is non-empty.
    stubLlm({ expansion: ["destroy all enemies", "end of the game"] });
    const result = await buildRagContext(SLUG, "How do I win?", KEY);

    // The victory chunk is short enough to survive its allocation uncut, so
    // its coverage is exactly 1...
    expect(result.excerptCoverage[3]).toBe(1);
    // ...and every coverage value is clamped into [0, 1], keyed only by the
    // excerpted pages.
    expect(Object.keys(result.excerptCoverage).map(Number)).toEqual(result.excerptedPages);
    for (const cov of Object.values(result.excerptCoverage)) {
      expect(cov).toBeGreaterThanOrEqual(0);
      expect(cov).toBeLessThanOrEqual(1);
    }
  });

  it("returns empty excerpt fields when the slug has no indexed chunks", async () => {
    stubLlm();

    const result = await buildRagContext("other-game", "How do I win?", KEY);

    expect(result.excerptedPages).toEqual([]);
    expect(result.excerptCoverage).toEqual({});
  });
});

// ─── measureExcerptDelivery (pure, CI-deterministic) ───────────────────────

describe("measureExcerptDelivery", () => {
  const MEASURE_CHUNKS: Chunk[] = [
    { id: "e1", slug: SLUG, title: "", page: 1, text: "Set up the board by placing the tokens." }, // 40 chars
    { id: "e2", slug: SLUG, title: "", page: 2, text: "Each turn you may attack with your forces." }, // 43 chars
  ];

  it("parses excerptedPages from the --- Page N --- blocks, sorted by page number", () => {
    const excerpts = "--- Page 2 ---\nabc\n\n--- Page 1 ---\ndef";
    expect(measureExcerptDelivery(excerpts, MEASURE_CHUNKS).excerptedPages).toEqual([1, 2]);
  });

  it("parses multi-digit page numbers distinctly (1, 10, 100)", () => {
    const excerpts = "--- Page 1 ---\na\n\n--- Page 10 ---\nb\n\n--- Page 100 ---\nc";
    expect(measureExcerptDelivery(excerpts, MEASURE_CHUNKS).excerptedPages).toEqual([1, 10, 100]);
  });

  it("computes coverage as delivered chars / original page length", () => {
    // p.1 delivers 3 of its 40 chars (7.5%); p.2 delivers all 43 of its text.
    const excerpts =
      "--- Page 1 ---\ndef\n\n--- Page 2 ---\nEach turn you may attack with your forces.";
    const { excerptCoverage } = measureExcerptDelivery(excerpts, MEASURE_CHUNKS);
    expect(excerptCoverage[1]).toBeCloseTo(3 / 40);
    expect(excerptCoverage[2]).toBe(1);
  });

  it("sums delivered chars across duplicate page blocks", () => {
    // Two blocks for the same page (base + expansion chunks) add up.
    const excerpts = "--- Page 1 ---\nab\n\n--- Page 1 ---\ncd";
    const { excerptedPages, excerptCoverage } = measureExcerptDelivery(excerpts, MEASURE_CHUNKS);
    expect(excerptedPages).toEqual([1]);
    expect(excerptCoverage[1]).toBeCloseTo(4 / 40);
  });

  it("clamps coverage to 1 when delivered chars exceed the original length", () => {
    const excerpts = `--- Page 1 ---\n${"x".repeat(41)}`;
    expect(measureExcerptDelivery(excerpts, MEASURE_CHUNKS).excerptCoverage[1]).toBe(1);
  });

  it("omits pages that are not in the context string", () => {
    const { excerptedPages, excerptCoverage } = measureExcerptDelivery("--- Page 1 ---\nab", MEASURE_CHUNKS);
    expect(excerptedPages).toEqual([1]);
    expect(2 in excerptCoverage).toBe(false);
  });

  it("returns empty results for an empty context string", () => {
    expect(measureExcerptDelivery("", MEASURE_CHUNKS)).toEqual({ excerptedPages: [], excerptCoverage: {} });
  });
});

// ─── buildRagContext — section-anchored boost (issue #63) ──────────────────
//
// When the query type maps to a TOC section, the section's pages are boosted
// into the candidate set so the page that answers the question is always in
// the excerpts, even when lexical retrieval can't discriminate a common-word
// query.

describe("buildRagContext — section-anchored boost (issue #63)", () => {
  beforeEach(() => {
    vi.mocked(loadIndex).mockResolvedValue(CHUNKS);
  });

  it("boosts the setup section page when lexical retrieval can't discriminate", async () => {
    // The setup page has NO overlap with the query's distinctive term ("begin")
    // — base retrieval returns no candidates at all, so the evidence gate
    // (issue #68) fires the expansion. The stubbed variants match the setup
    // chunk; the section boost must keep p. 1 in the context.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "s1", slug: SLUG, title: "Setup", page: 1, text: "Start by placing all tokens on the board and dealing the cards." },
      { id: "s2", slug: SLUG, title: "Combat", page: 2, text: "Each turn you may attack with your forces during the game." },
      { id: "s3", slug: SLUG, title: "Victory", page: 3, text: "You win when all enemies are destroyed in the game." },
    ]);
    stubLlm({ expansion: ["placing tokens", "start the game"] });

    const result = await buildRagContext(SLUG, "How do I begin?", KEY);

    expect(result.queryType).toBe("setup");
    expect(result.pages).toContain(1);
    expect(result.excerpts).toContain("--- Page 1 ---");
  });

  it("does not double-boost a page already boosted by an explicit reference", async () => {
    // The setup page is also explicitly referenced — the explicit boost (a
    // bounded prior, +20% over the top genuine lexical score) takes priority
    // and the section boost is skipped.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "s1", slug: SLUG, title: "Setup", page: 1, text: "Set up the board by placing the tokens." },
      { id: "s2", slug: SLUG, title: "Combat", page: 2, text: "Each turn you may attack with your forces." },
    ]);
    stubLlm();

    const result = await buildRagContext(SLUG, "Tell me about p. 1 and how to set up", KEY);

    // The explicit page reference boosts p. 1 with a bounded prior (+20% over
    // the top genuine lexical score); the section boost sees it's already
    // boosted and skips.
    expect(result.pages).toContain(1);
    expect(result.excerpts.startsWith("--- Page 1 ---")).toBe(true);
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
    // A short query whose base result fails the quality gate — the evidence
    // gate (issue #68) fires the expansion here, so this pins the
    // deterministic fast path (no model call) plus the skipped re-rank: the
    // weak candidate still carries through in lexical order.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "v1", slug: SLUG, title: "", page: 1, text: "You win when all enemies are destroyed." },
    ]);
    mockFetch.mockImplementation(() => new Promise<Response>(() => {}));

    const result = await buildRagContext(SLUG, "how do i win", KEY, undefined, {
      skipRerank: true,
      expansionMode: "deterministic",
    });

    // No model call at all...
    expect(mockFetch).not.toHaveBeenCalled();
    // ...and the weak candidate still carries through in lexical order.
    expect(result.excerpts).toContain("--- Page 1 ---");
    expect(result.pages).toEqual([1]);
  });
});

// ─── Prewarm head start + finishRagContext parity (issue #67) ───────────────
//
// A prewarm hit and a cold request must produce byte-identical excerpts. Both
// paths share buildPrewarmHeadStart (the deterministic prefix — zero model
// calls) and finishRagContext (the quality stages), so parity holds by
// construction: these tests pin it with a mocked LLM, CI-deterministic.

describe("prewarm head start + finishRagContext parity (issue #67)", () => {
  beforeEach(() => {
    vi.mocked(loadIndex).mockResolvedValue(CHUNKS);
  });

  it("builds the head start with zero model calls", async () => {
    // The fetch stub hangs forever: if buildPrewarmHeadStart made ANY model
    // call (expansion, re-rank, or classification), this test would time out.
    mockFetch.mockImplementation(() => new Promise<Response>(() => {}));

    const headStart = await buildPrewarmHeadStart(SLUG, "How do I win?");

    expect(mockFetch).not.toHaveBeenCalled();
    // The deterministic prefix is a pure function of (slug, question): the
    // index chunks, base retrieval candidates, and the keyword classification.
    // (The DF table is built from the on-disk index, which this fixture's slug
    // is not part of, so it is undefined here.)
    expect(headStart.chunks).toEqual(CHUNKS);
    expect(headStart.lexicalCandidates.length).toBeGreaterThan(0);
  });

  it("produces byte-identical excerpts for a prewarm hit and a cold request", async () => {
    stubLlm({ rerank: [5, 1] });

    // Cold path: the full pipeline from scratch.
    const cold = await buildRagContext(SLUG, "How do I win?", KEY);

    // Prewarm-hit path: the cached head start, finished by the quality stages.
    const headStart = await buildPrewarmHeadStart(SLUG, "How do I win?");
    const warmed = await finishRagContext(headStart, SLUG, "How do I win?", KEY);

    // Byte-identical excerpts — the parity guarantee of issue #67.
    expect(warmed.excerpts).toBe(cold.excerpts);
    // The rest of the context matches too (same configuration and stages).
    expect(warmed.toc).toBe(cold.toc);
    expect(warmed.pages).toEqual(cold.pages);
    expect(warmed.rankedPages).toEqual(cold.rankedPages);
    expect(warmed.confidence).toBe(cold.confidence);
  });

  it("keeps parity when the weak-base path fires the expansion", async () => {
    // Chunks that only match rephrased variants, not the original question:
    // the base result is weak, so BOTH paths fire + await the (mocked) LLM
    // expansion and re-retrieve with its variants.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "w1", slug: SLUG, title: "", page: 1, text: "The weather track shifts with the seasons." },
      { id: "a2", slug: SLUG, title: "", page: 2, text: "Each turn you may attack with your forces." },
      { id: "b4", slug: SLUG, title: "", page: 4, text: "Combat rules: resolve the battle each round." },
    ]);
    stubLlm({ expansion: ["enemy attack", "combat rules"] });

    const cold = await buildRagContext(SLUG, "How do I deal with enemy attacks?", KEY);

    const headStart = await buildPrewarmHeadStart(SLUG, "How do I deal with enemy attacks?");
    const warmed = await finishRagContext(headStart, SLUG, "How do I deal with enemy attacks?", KEY);

    // Both paths fired the expansion (one LLM call each)...
    expect(expansionCalls()).toBe(2);
    // ...and still produce byte-identical excerpts.
    expect(warmed.excerpts).toBe(cold.excerpts);
    expect(warmed.toc).toBe(cold.toc);
    expect(warmed.pages).toEqual(cold.pages);
    expect(warmed.confidence).toBe(cold.confidence);
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

  it("reorders candidates by decision-model score combined with TF-IDF, both normalized", async () => {
    // The model rates c1 (index 0) highly (4) and c2 (index 1) low (1).
    // maxScore = 8, so c1: (2/8)*1 + (4/4)*3 = 0.25 + 3 = 3.25
    //               c2: (8/8)*1 + (1/4)*3 = 1 + 0.75 = 1.75
    mockFetch.mockResolvedValue(
      rawJson({
        answers: { c0: { type: "score", score: 4 }, c1: { type: "score", score: 1 } },
      })
    );

    const result = await decisionRerank("set up the board", candidates);
    // c1: 3.25 beats c2: 1.75.
    expect(result![0].id).toBe("c1");
    expect(result![0].score).toBeCloseTo(3.25);
    expect(result![1].score).toBeCloseTo(1.75);
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
    // A strong base result (top score ≥ 3, more than two content terms) keeps
    // the evidence gate (issue #68) closed, so no expansion is needed — and
    // the model's "no rephrasing" verdict can no longer suppress one either.
    stubBoth({ queryType: "specific-rule", needsExpansion: false });

    const result = await buildRagContext(SLUG, "How do I set up the board for the game?", KEY, undefined, {
      useDecisionModel: true,
    });

    // No expansion LLM call was made — the model's verdict gated it off.
    expect(llmExpandCalls()).toBe(0);
    expect(result.excerpts.length).toBeGreaterThan(0);
  });

  it("uses the decision model's score call for re-ranking instead of the LLM", async () => {
    // A query with two content terms fires the evidence-based expansion
    // (issue #68); the stubbed variants match BOTH chunks equally, so the
    // merged result has no clear winner and a quality gate is needed.
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "r1", slug: SLUG, title: "", page: 1, text: "The board has many tokens and markers." },
      { id: "r2", slug: SLUG, title: "", page: 2, text: "Tokens and markers are placed on the board." },
    ]);
    // The model strongly prefers candidate 0 over candidate 1.
    stubBoth({ relevance: [4, 0], expansion: ["board markers", "tokens markers"] });

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
