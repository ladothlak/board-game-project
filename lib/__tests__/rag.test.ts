import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyQuery,
  multiQueryRetrieve,
  followCrossRefs,
  adaptiveContext,
  estimateConfidence,
  hierarchicalToc,

  detectExplicitPages,
  expandQuery,
  rerank,
} from "../rag";
import type { Chunk } from "../retrieve";

// ─── Shared fetch mock (for the LLM-backed helpers' fallback paths) ────────────

const mockFetch = vi.fn();

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

// ─── classifyQuery ──────────────────────────────────────────────────────────────

describe("classifyQuery", () => {
  it("classifies setup questions", () => {
    expect(classifyQuery("How do I set up the board?")).toBe("setup");
  });

  it("classifies turn-structure questions", () => {
    expect(classifyQuery("What happens on a turn?")).toBe("turn-structure");
  });

  it("classifies specific-rule questions", () => {
    expect(classifyQuery("Can I do this?")).toBe("specific-rule");
  });

  it("classifies comparison questions", () => {
    expect(classifyQuery("Compare the two games")).toBe("comparison");
  });

  it("falls back to general for unmatched questions", () => {
    expect(classifyQuery("Hello?")).toBe("general");
  });

  it("is case-insensitive", () => {
    expect(classifyQuery("SETUP INSTRUCTIONS")).toBe("setup");
  });
});

// ─── multiQueryRetrieve ──────────────────────────────────────────────────────────

const CHUNKS: Chunk[] = [
  { id: "c1", slug: "g", title: "Setup", page: 1, text: "Set up the board by placing the tokens." },
  { id: "c2", slug: "g", title: "Combat", page: 2, text: "Each turn you may attack with your forces on the board." },
  { id: "c3", slug: "g", title: "Victory", page: 3, text: "You win when all enemies are destroyed." },
];

describe("multiQueryRetrieve", () => {
  it("merges results from multiple queries and sorts by score", () => {
    const results = multiQueryRetrieve(CHUNKS, ["setup the board", "attack with forces"]);
    expect(results.length).toBeGreaterThan(0);
    // Sorted descending by score.
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it("boosts chunks that appear in multiple query results", () => {
    // c2 matches both "attack with forces" (strongly) and "setup the board"
    // (shares "board"), so it should outrank c1 which only matches one query.
    const results = multiQueryRetrieve(CHUNKS, ["setup the board", "attack with forces"]);
    expect(results[0].id).toBe("c2");
  });

  it("returns at most k chunks per merged result set", () => {
    const results = multiQueryRetrieve(CHUNKS, ["board", "attack"], 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ─── followCrossRefs ─────────────────────────────────────────────────────────────

describe("followCrossRefs", () => {
  const chunks: Chunk[] = [
    { id: "p1", slug: "g", title: "", page: 1, text: "See page 3 for the details." },
    { id: "p2", slug: "g", title: "", page: 2, text: "No references here." },
    { id: "p3", slug: "g", title: "", page: 3, text: "The details go here." },
  ];

  it("pulls in referenced pages with a reduced score", () => {
    const selected = [{ ...chunks[0], score: 10 }];
    const result = followCrossRefs(chunks, selected);
    expect(result).toHaveLength(2);
    expect(result[1].page).toBe(3);
    expect(result[1].score).toBeCloseTo(3); // 10 * 0.3
  });

  it("does not add pages already in the selection", () => {
    const selected = [
      { ...chunks[0], score: 10 },
      { ...chunks[2], score: 8 },
    ];
    const result = followCrossRefs(chunks, selected);
    expect(result).toHaveLength(2);
  });

  it("handles 'as described in page N' phrasing", () => {
    const chunks2: Chunk[] = [
      { id: "p1", slug: "g", title: "", page: 1, text: "As described in page 2, tokens are placed." },
      { id: "p2", slug: "g", title: "", page: 2, text: "Token placement rules." },
    ];
    const result = followCrossRefs(chunks2, [{ ...chunks2[0], score: 5 }]);
    expect(result).toHaveLength(2);
    expect(result[1].page).toBe(2);
  });

  it("ignores references to pages that don't exist", () => {
    const result = followCrossRefs(chunks, [{ ...chunks[0], score: 10 }]);
    // Only page 3 is referenced; no phantom pages added.
    expect(result.map((c) => c.page)).toEqual([1, 3]);
  });
});

// ─── adaptiveContext ─────────────────────────────────────────────────────────────

describe("adaptiveContext", () => {
  it("returns an empty string for an empty selection", () => {
    expect(adaptiveContext([])).toBe("");
  });

  it("includes the full text of a short chunk with its page header", () => {
    const out = adaptiveContext([{ ...CHUNKS[0], score: 5 }]);
    expect(out).toContain("--- Page 1 ---");
    expect(out).toContain("Set up the board by placing the tokens.");
  });

  it("caps every chunk at its proportional allocation", () => {
    const longA = "x".repeat(2300);
    const longB = "y".repeat(3000);
    const selected = [
      { ...CHUNKS[0], text: longA, score: 1 },
      { ...CHUNKS[1], text: longB, score: 1 },
    ];
    const out = adaptiveContext(selected, 2400);
    // Both pages are represented...
    expect(out).toContain("--- Page 1 ---");
    expect(out).toContain("--- Page 2 ---");
    // ...and each chunk is capped at its allocation (half the budget), so the
    // top chunk can no longer consume the whole budget with its full text.
    const [page1, page2] = out.split("\n\n");
    expect(page1.replace("--- Page 1 ---\n", "").length).toBe(1200);
    expect(page2.replace("--- Page 2 ---\n", "").length).toBe(1200);
  });
});

// ─── estimateConfidence ──────────────────────────────────────────────────────────

describe("estimateConfidence", () => {
  it("returns 0 for an empty selection", () => {
    expect(estimateConfidence([])).toBe(0);
  });

  it("caps at 1 for very high scores", () => {
    expect(estimateConfidence([{ ...CHUNKS[0], score: 20 }])).toBe(1);
  });

  it("scales linearly below the cap (score / 10)", () => {
    expect(estimateConfidence([{ ...CHUNKS[0], score: 5 }])).toBeCloseTo(0.5);
    expect(estimateConfidence([{ ...CHUNKS[0], score: 9 }, { ...CHUNKS[1], score: 3 }])).toBeCloseTo(0.9);
  });
});

// ─── hierarchicalToc ─────────────────────────────────────────────────────────────

describe("hierarchicalToc", () => {
  it("groups pages into named sections and lists unmatched pages under Other", () => {
    const chunks: Chunk[] = [
      { id: "p1", slug: "g", title: "", page: 1, text: "Introduction and overview of the game." },
      { id: "p2", slug: "g", title: "", page: 2, text: "Setup: prepare the board and place your pieces." },
      { id: "p3", slug: "g", title: "", page: 3, text: "Random text with no section keywords at all." },
    ];
    const toc = hierarchicalToc(chunks);
    expect(toc).toContain("Introduction / Overview: p. 1");
    expect(toc).toContain("Setup: p. 2");
    expect(toc).toContain("Other: p. 3");
  });

  it("assigns each page to at most one section (first match wins)", () => {
    const chunks: Chunk[] = [
      // Matches both Setup and Core Rules patterns; Setup is checked first.
      { id: "p1", slug: "g", title: "", page: 1, text: "Setup and the core rules of play." },
    ];
    const toc = hierarchicalToc(chunks);
    expect(toc).toContain("Setup: p. 1");
    expect(toc).not.toContain("Core Rules");
  });

  it("returns an empty string for no chunks", () => {
    expect(hierarchicalToc([])).toBe("");
  });
});

// ─── detectExplicitPages ─────────────────────────────────────────────────────────

describe("detectExplicitPages", () => {
  it("extracts 'page N' references", () => {
    expect(detectExplicitPages("Tell me about page 14")).toEqual([14]);
  });

  it("extracts 'on page N' references", () => {
    expect(detectExplicitPages("What is on page 5?")).toEqual([5]);
  });

  it("extracts multiple distinct pages and deduplicates", () => {
    const pages = detectExplicitPages("Compare p. 30 with page 5, and again page 5");
    expect(pages).toHaveLength(2);
    expect(pages).toContain(30);
    expect(pages).toContain(5);
  });

  it("returns an empty array when no pages are mentioned", () => {
    expect(detectExplicitPages("How do I win?")).toEqual([]);
  });
});

// ─── expandQuery (LLM-backed, fallback paths) ────────────────────────────────────

describe("expandQuery", () => {
  it("returns the original question when the LLM call fails", async () => {
    mockFetch.mockRejectedValue(new Error("provider down"));
    await expect(expandQuery("key", "How do I win?", "general")).resolves.toEqual(["How do I win?"]);
  });

  it("returns the original question when the LLM output has no JSON array", async () => {
    mockFetch.mockResolvedValue(llmResponse("sorry, I cannot help"));
    await expect(expandQuery("key", "How do I win?", "general")).resolves.toEqual(["How do I win?"]);
  });

  it("parses a valid JSON array of phrases from the LLM output", async () => {
    mockFetch.mockResolvedValue(llmResponse('Here you go: ["victory points", "end of game"] done'));
    const result = await expandQuery("key", "How do I win?", "general");
    expect(result).toEqual(["victory points", "end of game"]);
  });
});

// ─── rerank (LLM-backed, fallback paths) ─────────────────────────────────────────

describe("rerank", () => {
  const candidates = [
    { ...CHUNKS[0], score: 2 },
    { ...CHUNKS[1], score: 8 },
  ];

  it("returns the candidates unchanged when the LLM call fails", async () => {
    mockFetch.mockRejectedValue(new Error("provider down"));
    const result = await rerank("key", "question", candidates);
    expect(result).toEqual(candidates);
  });

  it("returns the candidates unchanged for an empty candidate list", async () => {
    const result = await rerank("key", "question", []);
    expect(result).toEqual([]);
  });

  it("combines LLM scores (weight 3) with TF-IDF scores (weight 1)", async () => {
    // LLM says candidate 0 is highly relevant (5) and candidate 1 is not (1).
    mockFetch.mockResolvedValue(llmResponse("[5, 1]"));
    const result = await rerank("key", "question", candidates);
    expect(result[0].id).toBe("c1"); // 2 + 5*3 = 17 beats 8 + 1*3 = 11
    expect(result[0].score).toBeCloseTo(17);
    expect(result[1].score).toBeCloseTo(11);
  });
});
