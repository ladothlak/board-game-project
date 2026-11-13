import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// RAG_CONTEXT_BUDGET is captured at module load (CONTEXT_BUDGET in lib/rag.ts),
// so it must be set BEFORE rag.ts is evaluated. This file uses a deliberately
// tiny budget to force adaptiveContext to drop low-relevance pages from the
// assembled context — exactly the condition issue #63 measures: a page that is
// in `pages` (candidate membership) but not in the excerpts.
process.env.RAG_CONTEXT_BUDGET = "600";

vi.mock("../retrieve", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, loadIndex: vi.fn() };
});

// Dynamic imports so the env var above is set before rag.ts evaluates.
const { buildRagContext } = await import("../rag");
const { loadIndex, resetRetrieveCachesForTest } = await import("../retrieve");

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  // The mocked loadIndex never advances the real mtime, so reset the
  // module-level DF cache — otherwise a stale table would leak between tests.
  resetRetrieveCachesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SLUG = "test-game";
const KEY = "test-key";

describe("buildRagContext — budget drops pages from the excerpts (issue #63)", () => {
  it("keeps a budget-dropped page out of excerptedPages even though it is in pages", async () => {
    // p.1 is explicitly referenced (boosted to score 100) and its text is one
    // long sentence, so its allocation consumes nearly the whole 600-char
    // budget; the low-relevance pages that follow exhaust the remainder, and
    // the last candidate is cut off by the budget break before it is even
    // processed — never making it into the context string. (p.5's text avoids
    // setup keywords so the section-anchored boost leaves it alone.)
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "b1", slug: SLUG, title: "Setup", page: 1, text: `Set up the board ${"a".repeat(2000)}` },
      { id: "b2", slug: SLUG, title: "", page: 2, text: "The board has many tokens." },
      { id: "b3", slug: SLUG, title: "", page: 3, text: "Place markers on the board." },
      // p.4 is a single sentence just over the 100-char floor cap, so it
      // delivers exactly the floor (100 chars) rather than its whole text —
      // which is what pushes the running total past the budget and drops p.5.
      { id: "b4", slug: SLUG, title: "", page: 4, text: "The board is the playing area where all pieces and markers are placed during play, forming the arena." },
      { id: "b5", slug: SLUG, title: "", page: 5, text: "All pieces are placed on the board during play." },
    ]);

    const result = await buildRagContext(SLUG, "Tell me about p. 1 and how to set up the board", KEY);

    // Candidate membership still includes every retrieved page...
    expect(result.pages).toEqual([1, 2, 3, 4, 5]);
    // ...but the budget dropped p.5 from the assembled context, so it is NOT
    // excerpted — exactly the divergence issue #63 makes measurable.
    expect(result.excerptedPages).toEqual([1, 2, 3, 4]);
    expect(result.excerpts).not.toContain("--- Page 5 ---");

    // Coverage reflects delivered chars: p.1 was cut to its allocation (well
    // under its 2000+ char original), p.2-p.3 survived whole, p.4 was cut to
    // the 100-char floor cap, and the dropped page has no coverage entry at all.
    expect(result.excerptCoverage[1]).toBeGreaterThan(0);
    expect(result.excerptCoverage[1]).toBeLessThan(1);
    expect(result.excerptCoverage[2]).toBe(1);
    expect(result.excerptCoverage[3]).toBe(1);
    expect(result.excerptCoverage[4]).toBeCloseTo(100 / 101, 10);
    expect(5 in result.excerptCoverage).toBe(false);

    // No LLM call: the explicit page reference gates expansion off and skips
    // the re-rank, so this stays fully deterministic.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
