import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// RAG_CONTEXT_BUDGET is captured at module load (CONTEXT_BUDGET in lib/rag.ts),
// so it must be set BEFORE rag.ts is evaluated. This file uses a deliberately
// tiny budget to force adaptiveContext to drop low-relevance pages from the
// assembled context — exactly the condition issue #63 measures: a page that is
// in `pages` (candidate membership) but not in the excerpts. Under the
// two-pass assembly (issue #64), a dropped page is also removed from
// `pages`/`rankedPages`, so this fixture now pins that no-phantom-pages
// contract: seven chunks against a 600-char budget means only six minimum
// windows fit, and the seventh chunk's page is claimed by nothing.
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
  it("drops a budget-starved page from pages and excerptedPages alike (no phantom pages)", async () => {
    // p.1 is explicitly referenced (boosted to score 100) and its text is one
    // long sentence; the six low-relevance pages that follow each need the
    // 100-char minimum window, so seven chunks (700 chars of floors) no longer
    // fit in the 600-char budget. The seventh candidate is dropped from the
    // assembly — and, per issue #64, from `pages`/`rankedPages` too, so a page
    // is never claimed without delivered text. (p.2-p.7's texts avoid setup
    // keywords so the section-anchored boost leaves them alone; p.2-p.6 share
    // one query term and the same token count so their lexical scores tie and
    // candidate order falls back to page order.)
    vi.mocked(loadIndex).mockResolvedValue([
      { id: "b1", slug: SLUG, title: "Setup", page: 1, text: `Set up the board ${"a".repeat(2000)}` },
      { id: "b2", slug: SLUG, title: "", page: 2, text: "The board has many tokens." },
      { id: "b3", slug: SLUG, title: "", page: 3, text: "The board holds new markers." },
      { id: "b4", slug: SLUG, title: "", page: 4, text: "The board keeps old pieces." },
      { id: "b5", slug: SLUG, title: "", page: 5, text: "The board takes fresh cards." },
      { id: "b6", slug: SLUG, title: "", page: 6, text: "The board ends each round." },
      { id: "b7", slug: SLUG, title: "", page: 7, text: "Tokens are scored at the end of each turn." },
    ]);

    const result = await buildRagContext(SLUG, "Tell me about p. 1 and how to set up the board", KEY);

    // The budget-starved page is claimed by nothing: not in the assembled
    // context, not in `pages`, not in `rankedPages` — no phantom page.
    expect(result.excerpts).not.toContain("--- Page 7 ---");
    expect(result.pages).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.rankedPages).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.excerptedPages).toEqual([1, 2, 3, 4, 5, 6]);

    // Coverage reflects delivered chars: p.1 was cut to its allocation (well
    // under its 2000+ char original), p.2-p.6 survived whole, and the dropped
    // page has no coverage entry at all.
    expect(result.excerptCoverage[1]).toBeGreaterThan(0);
    expect(result.excerptCoverage[1]).toBeLessThan(1);
    for (const p of [2, 3, 4, 5, 6]) {
      expect(result.excerptCoverage[p]).toBe(1);
    }
    expect(7 in result.excerptCoverage).toBe(false);

    // No LLM call: the explicit page reference gates expansion off and skips
    // the re-rank, so this stays fully deterministic.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
