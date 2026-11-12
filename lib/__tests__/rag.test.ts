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

  it("caps the number of extra pages at maxExtra", () => {
    // A reference-heavy chunk (like a room sheet) points at many pages;
    // following all of them would dilute the context budget with noise.
    const refChunk: Chunk = {
      id: "p1",
      slug: "g",
      title: "",
      page: 1,
      text: "See page 2. See page 3. See page 4. See page 5. See page 6. See page 7.",
    };
    const many: Chunk[] = [
      refChunk,
      ...[2, 3, 4, 5, 6, 7].map((p) => ({ id: `p${p}`, slug: "g", title: "", page: p, text: `Page ${p} content.` })),
    ];
    const result = followCrossRefs(many, [{ ...refChunk, score: 10 }]);
    // Exactly maxExtra (4) extras are added, in selection order.
    expect(result).toHaveLength(5);
    expect(result.map((c) => c.page)).toEqual([1, 2, 3, 4, 5]);
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

  it("keeps the most query-relevant sentences when cutting a long chunk", () => {
    // An answer sitting deep in a long page must survive the cut: the
    // relevant sentence is kept, the filler around it is dropped.
    const filler = "x".repeat(300);
    const relevant = "The contamination check decides who dies.";
    const text = `${filler}. ${relevant} ${filler}`;
    const selected = [{ ...CHUNKS[0], text, score: 1 }];
    // Budget smaller than the chunk so a cut is forced.
    const out = adaptiveContext(
      selected,
      400,
      new Set(["contamination", "dies"]),
      new Map([["contamination", 2], ["dies", 1]]),
      10
    );
    const pagePart = out.replace("--- Page 1 ---\n", "");
    expect(pagePart).toContain(relevant);
    expect(pagePart.length).toBeLessThan(text.length);
  });

  it("falls back to a prefix slice when no sentence matches the query terms", () => {
    // No punctuation, no query terms: every sentence scores 0, so the cut
    // degrades to a plain prefix slice (never less text than a plain cut).
    const text = "x".repeat(500) + " end";
    const selected = [{ ...CHUNKS[0], text, score: 1 }];
    const out = adaptiveContext(selected, 400, new Set(["contamination"]), undefined, 10);
    const pagePart = out.replace("--- Page 1 ---\n", "");
    expect(pagePart).toBe(text.slice(0, 400));
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

  it("previews candidates with their most query-relevant sentences, not just the first 200 chars", async () => {
    // A relevant passage deep in a long chunk must reach the LLM so it can be
    // rated accurately; the filler around it must not.
    const filler = "x".repeat(400);
    const relevant = "Set up the board.";
    const longChunk = { ...CHUNKS[0], text: `${filler}. ${relevant} ${"y".repeat(400)}`, score: 5 };
    mockFetch.mockResolvedValue(llmResponse("[5]"));

    await rerank("key", "question", [longChunk], new Set(["setup", "board"]), undefined, 1);

    const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body)) as { messages: { content: string }[] };
    const prompt = body.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain(relevant);
    expect(prompt).not.toContain(filler.slice(0, 100));
  });
});
