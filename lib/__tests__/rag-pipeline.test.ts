import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRagContext } from "../rag";
import { loadIndex } from "../retrieve";
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

    // One LLM call: expansion runs, but re-ranking is skipped because the
    // boosted expansion chunk (score 90) is a clear TF-IDF winner.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(expansionCalls()).toBe(1);

    // The expansion chunk (boosted to score 90) leads the context.
    expect(result.excerpts.startsWith("--- Page 10 ---")).toBe(true);
    expect(result.excerpts).toContain("The Doom expansion adds terrifying new enemies.");
    expect(result.confidence).toBe(1);
  });

  it("reports low confidence below the fallback threshold when retrieval is weak and re-ranking fails", async () => {
    mockFetch.mockRejectedValue(new Error("provider down"));

    // "How do I win?" only weakly matches the victory chunk, and with the
    // LLM unavailable the raw (low) TF-IDF score carries through.
    const result = await buildRagContext(SLUG, "How do I win?", KEY);

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

  it("truncates later chunks to fit the adaptive context budget", async () => {
    const longSetup = `Set up the board. ${"a".repeat(1980)}`; // ~2000 chars
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
    // ...the first chunk keeps its full text...
    expect(result.excerpts).toContain(longSetup);
    // ...but the second is truncated to fit the remaining budget.
    const page2Part = result.excerpts.split("--- Page 2 ---\n")[1];
    expect(page2Part.length).toBeLessThan(longCombat.length);
    expect(page2Part.length).toBeLessThanOrEqual(402);

    // The whole context stays within the ~2400-char budget plus headers.
    expect(result.excerpts.length).toBeLessThan(2600);
  });

  it("returns a graceful empty context when the slug has no indexed chunks", async () => {
    stubLlm();

    const result = await buildRagContext("other-game", "How do I win?", KEY);

    expect(result).toEqual({ excerpts: "", toc: "", confidence: 0, pages: [] });
    // No LLM work is done for a game with no index.
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
