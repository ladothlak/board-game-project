import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRagContext } from "../rag";

// ─── Evidence-based expansion gate (issue #68) — real-index regression ─────
//
// "How do I win?" carries no rulebook terms of its own: on the real search
// index it retrieves zero lexical candidates, so the evidence-based gate must
// fire the expansion even for this short query. Before issue #68 the gate was
// a length check (`question.length > 20`), so these questions returned an
// empty context. These regression tests run the full pipeline against the
// REAL index (no loadIndex mock) on the deterministic fast path
// (expansionMode "deterministic" + skipRerank), so they make zero model calls
// and stay green in CI: a rejecting fetch stub pins the no-network contract,
// and the not-called assertion catches any stage that reaches for one.

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockRejectedValue(new Error("no network in CI"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const FAST_PATH = { expansionMode: "deterministic", skipRerank: true } as const;

describe("evidence-based expansion gate on the real index (issue #68)", () => {
  // The labelled answer pages per game (rag-dataset.ts): the regression
  // contract is that the short question surfaces them, not just any page.
  it.each([
    ["azul", [3, 5]],
    ["coup", [1]],
  ])("returns non-empty candidates for 'How do I win?' on %s", async (slug, expectedPages) => {
    // The base retrieval finds nothing for this question (two content terms,
    // no lexical hits), so the gate fires and the deterministic expansion's
    // synonym phrases ("victory condition", "end of the game") re-retrieve.
    const result = await buildRagContext(slug, "How do I win?", "test-key", undefined, { ...FAST_PATH });

    // The short question no longer returns an empty context: candidates
    // survive into pages and excerpts alike.
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.excerpts).not.toBe("");
    for (const p of result.pages) {
      expect(result.excerpts).toContain(`--- Page ${p} ---`);
    }
    // The labelled answer pages make it into the context.
    for (const p of expectedPages) {
      expect(result.pages).toContain(p);
    }
    // No model call at any stage — the deterministic fast path is
    // model-call-free (prewarm compatibility, issues #60/#67).
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
