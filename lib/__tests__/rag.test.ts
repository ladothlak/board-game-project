import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyQuery,
  multiQueryRetrieve,
  followCrossRefs,
  adaptiveContext,
  estimateConfidence,
  hierarchicalToc,
  boostCandidates,
  passesQualityGate,
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

  // ─── issue #64: neighbour windows + two-pass budget allocation ─────────────

  it("keeps ±1 neighbour windows around kept sentences so adjacent context survives", () => {
    // The answer sentence matches the query; its non-matching neighbours must
    // survive the cut instead of being dropped as isolated keyword fragments.
    const before = "Fill the well with water.";
    const relevant = "The contamination check decides who dies.";
    const after = "Then everyone draws a card.";
    const text = `${before} ${relevant} ${after}`;
    const selected = [{ ...CHUNKS[0], text, score: 1 }];
    const out = adaptiveContext(
      selected,
      400,
      new Set(["contamination", "dies"]),
      new Map([["contamination", 2], ["dies", 1]]),
      10
    );
    // All three sentences fit the cap: the answer plus both neighbours.
    expect(out.replace("--- Page 1 ---\n", "")).toBe(text);
  });

  it("keeps the bare sentence when its neighbour window doesn't fit the cap", () => {
    // The ±1 window (644 chars) is far bigger than the cap, but the answer
    // sentence alone (41 chars) fits — long filler must not starve the answer.
    const relevant = "The contamination check decides who dies.";
    const text = `${"x".repeat(300)}. ${relevant} ${"y".repeat(300)}`;
    const selected = [{ ...CHUNKS[0], text, score: 1 }];
    const out = adaptiveContext(
      selected,
      150,
      new Set(["contamination", "dies"]),
      new Map([["contamination", 2], ["dies", 1]]),
      10
    );
    expect(out.replace("--- Page 1 ---\n", "")).toBe(relevant);
  });

  it("redistributes unused budget from sparse pages to truncated pages (pass 2)", () => {
    // Page 1 is long and query-relevant; page 2 is a short sparse page whose
    // first-pass allocation goes mostly unused. The second pass must hand the
    // spare budget to page 1 so it delivers far more than its first-pass share.
    const relevant = "The contamination check decides who dies.";
    const longText = `${"x".repeat(300)}. ${relevant} ${"y".repeat(300)}`; // 645 chars
    const selected = [
      { ...CHUNKS[0], text: longText, score: 1 },
      { ...CHUNKS[1], text: "Short sparse page.", score: 1 },
    ];
    const out = adaptiveContext(
      selected,
      800,
      new Set(["contamination", "dies"]),
      new Map([["contamination", 2], ["dies", 1]]),
      10
    );
    const [p1, p2] = out.split("\n\n");
    // Page 1 grew from its 41-char first-pass window to the full ±1 window
    // (644 chars) using page 2's unused budget — and the total stayed ≤ 800.
    expect(p1.replace("--- Page 1 ---\n", "").length).toBe(644);
    expect(p2.replace("--- Page 2 ---\n", "")).toBe("Short sparse page.");
    const delivered = p1.length + p2.length; // headers included
    expect(delivered - 36).toBeLessThanOrEqual(800); // 36 = two headers + join
  });

  it("guarantees every included page at least its minimum window", () => {
    // Four long chunks against a tight budget: each must still deliver at
    // least the 100-char floor (one contiguous sentence window) — no page is
    // represented by zero chars.
    const selected = Array.from({ length: 4 }, (_, i) => ({
      ...CHUNKS[0],
      page: i + 1,
      text: "x".repeat(500),
      score: 1,
    }));
    const out = adaptiveContext(selected, 800);
    const parts = out.split("\n\n");
    expect(parts).toHaveLength(4);
    for (const part of parts) {
      expect(part.replace(/^--- Page \d+ ---\n/, "").length).toBeGreaterThanOrEqual(100);
    }
  });

  it("drops trailing chunks whose minimum window no longer fits the budget", () => {
    // Nine long chunks against a 600-char budget: only six 100-char floors fit,
    // so the three lowest-relevance chunks never make it into the string —
    // buildRagContext keeps their pages out of `pages`/`rankedPages` too.
    const selected = Array.from({ length: 9 }, (_, i) => ({
      ...CHUNKS[0],
      page: i + 1,
      text: "x".repeat(500),
      score: 1,
    }));
    const out = adaptiveContext(selected, 600);
    for (const p of [1, 2, 3, 4, 5, 6]) {
      expect(out).toContain(`--- Page ${p} ---`);
    }
    for (const p of [7, 8, 9]) {
      expect(out).not.toContain(`--- Page ${p} ---`);
    }
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
  it("falls back to deterministic expansion when the LLM call fails", async () => {
    mockFetch.mockRejectedValue(new Error("provider down"));
    const result = await expandQuery("key", "How do I win?", "general");
    // Not just [question] — a deterministic n-gram expansion is produced.
    expect(result).not.toEqual(["How do I win?"]);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeLessThanOrEqual(4);
  });

  it("falls back to deterministic expansion when the LLM output has no JSON array", async () => {
    mockFetch.mockResolvedValue(llmResponse("sorry, I cannot help"));
    const result = await expandQuery("key", "How do I win?", "general");
    expect(result).not.toEqual(["How do I win?"]);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to deterministic expansion when the LLM returns an echo", async () => {
    // The LLM echoes the question verbatim.
    mockFetch.mockResolvedValue(llmResponse('["How do I win?"]'));
    const result = await expandQuery("key", "How do I win?", "general");
    expect(result).not.toEqual(["How do I win?"]);
    expect(result.length).toBeGreaterThanOrEqual(2);
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

  it("combines LLM scores (weight 3) with TF-IDF scores (weight 1), both normalized", async () => {
    // LLM says candidate 0 is highly relevant (5) and candidate 1 is not (1).
    // maxScore = 8, so c1: (2/8)*1 + (5/5)*3 = 0.25 + 3 = 3.25
    //               c2: (8/8)*1 + (1/5)*3 = 1 + 0.6 = 1.6
    mockFetch.mockResolvedValue(llmResponse("[5, 1]"));
    const result = await rerank("key", "question", candidates);
    expect(result[0].id).toBe("c1"); // 3.25 beats 1.6
    expect(result[0].score).toBeCloseTo(3.25);
    expect(result[1].score).toBeCloseTo(1.6);
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

// ─── issue #65: bounded priors, gate independence, confidence non-saturation ──

describe("boostCandidates (bounded prior, issue #65)", () => {
  const chunks: Chunk[] = [
    { id: "b1", slug: "g", title: "", page: 1, text: "Set up the board by placing the tokens." },
    { id: "b2", slug: "g", title: "", page: 2, text: "Each turn you may attack with your forces." },
    { id: "b3", slug: "g", title: "", page: 42, text: "The reference table lists all keywords." },
  ];

  it("caps the boosted score at +EXPLICIT_BOOST_FACTOR over the top genuine lexical score", () => {
    // Top genuine lexical score is 10. The boost must be ≤ 10 * 1.2 = 12.
    const candidates = [
      { ...chunks[0], score: 10 },
      { ...chunks[1], score: 5 },
    ];
    const boosted = boostCandidates(candidates, chunks, [42], undefined, "question");
    const page42 = boosted.find((c) => c.page === 42)!;
    expect(page42.isBoosted).toBe(true);
    // Bounded prior: topLexical * (1 + 0.2) = 10 * 1.2 = 12.
    expect(page42.score).toBeCloseTo(12);
    // Never an absolute 80/100 — stays within the +10–20% cap.
    expect(page42.score).toBeLessThanOrEqual(12);
  });

  it("does not use a boosted score as its own baseline (no compounding)", () => {
    // If a page is already boosted, its score must not be used as the
    // topLexical baseline for another boost.
    const candidates = [
      { ...chunks[0], score: 10 },
      { ...chunks[1], score: 5, isBoosted: true },
    ];
    const boosted = boostCandidates(candidates, chunks, [42], undefined, "question");
    const page42 = boosted.find((c) => c.page === 42)!;
    // topLexical = 10 (the non-boosted score), not 5 (the boosted one).
    expect(page42.score).toBeCloseTo(12); // 10 * 1.2
  });

  it("marks boosted entries with isBoosted: true", () => {
    const candidates = [{ ...chunks[0], score: 10 }];
    const boosted = boostCandidates(candidates, chunks, [42], undefined, "question");
    expect(boosted.find((c) => c.page === 42)?.isBoosted).toBe(true);
    // Non-boosted entries remain unmarked.
    expect(boosted.find((c) => c.page === 1)?.isBoosted).toBeUndefined();
  });

  it("boosts mentioned expansion chunks with the same bounded prior", () => {
    const expChunks: Chunk[] = [
      ...chunks,
      { id: "exp-doom", slug: "g", title: "Doom", page: 10, text: "The Doom expansion adds enemies.", isExpansion: true },
    ];
    const candidates = [{ ...chunks[0], score: 10 }];
    const boosted = boostCandidates(candidates, expChunks, [], ["Doom"], "How does the Doom expansion work?");
    const expPage = boosted.find((c) => c.page === 10)!;
    expect(expPage.isBoosted).toBe(true);
    expect(expPage.score).toBeCloseTo(12); // 10 * 1.2
  });
});

describe("passesQualityGate (independent of boost, issue #65)", () => {
  it("returns false when only boosted candidates exist", () => {
    // A single boosted candidate with a high score must NOT satisfy the gate:
    // a boost is a prior, not evidence.
    const candidates = [
      { ...CHUNKS[0], score: 50, isBoosted: true },
    ];
    expect(passesQualityGate(candidates, new Set(["setup", "board"]))).toBe(false);
  });

  it("returns false when the top candidate is boosted and no genuine winner exists", () => {
    // The boosted page scores high, but the genuine candidates are weak.
    const candidates = [
      { ...CHUNKS[0], score: 40, isBoosted: true },
      { ...CHUNKS[1], score: 1 },
      { ...CHUNKS[2], score: 0.5 },
    ];
    // The gate checks candidates[0] (the boosted one) — it must fail because
    // the function is called on the pre-boost list by buildRagContext. Here we
    // simulate what happens if someone mistakenly passes the post-boost list:
    // the top score is 40, but the text check still applies.
    // In practice, buildRagContext always passes lexicalCandidates (pre-boost),
    // so this test documents the contract.
    expect(passesQualityGate(candidates, new Set(["setup", "board"]))).toBe(false);
  });

  it("returns true for a genuine (non-boosted) clear winner", () => {
    const candidates = [
      { ...CHUNKS[0], score: 10 },
      { ...CHUNKS[1], score: 3 },
    ];
    // "set" and "board" both appear in the top chunk's text.
    expect(passesQualityGate(candidates, new Set(["set", "board"]))).toBe(true);
  });
});

describe("estimateConfidence (ignores boost magnitude, issue #65)", () => {
  it("returns 0 when all candidates are boosted (no genuine evidence)", () => {
    const candidates = [
      { ...CHUNKS[0], score: 100, isBoosted: true },
      { ...CHUNKS[1], score: 90, isBoosted: true },
    ];
    expect(estimateConfidence(candidates)).toBe(0);
  });

  it("does not saturate to 1.0 on a boosted query with weak genuine evidence", () => {
    // A boosted page scores 100, but the only genuine candidate scores 2.
    // Confidence must reflect the genuine score (0.2), not the boost.
    const candidates = [
      { ...CHUNKS[0], score: 100, isBoosted: true },
      { ...CHUNKS[1], score: 2 },
    ];
    expect(estimateConfidence(candidates)).toBeCloseTo(0.2);
  });

  it("still uses genuine scores when no candidates are boosted", () => {
    const candidates = [
      { ...CHUNKS[0], score: 15 },
      { ...CHUNKS[1], score: 8 },
    ];
    expect(estimateConfidence(candidates)).toBe(1); // min(1, 15/10)
  });
});

describe("rerank corrects bounded boosts (issue #65)", () => {
  it("a wrong boosted page cannot outrank a direct lexical hit after rerank", async () => {
    // The boosted page (score 12, isBoosted) is ahead of the genuine hit
    // (score 10). The LLM rates the genuine hit highly (5) and the boosted
    // page low (1). After normalization, the re-rank's swing (up to 3)
    // dominates the lexical component (max 1), so the genuine hit wins.
    const candidates = [
      { ...CHUNKS[0], score: 12, isBoosted: true }, // boosted page (p. 1)
      { ...CHUNKS[1], score: 10 },                  // genuine hit (p. 2)
    ];
    // LLM says: candidate 0 (boosted) is irrelevant (1), candidate 1 (genuine) is perfect (5).
    mockFetch.mockResolvedValue(llmResponse("[1, 5]"));
    const result = await rerank("key", "question", candidates);
    // The genuine hit must outrank the boosted page.
    expect(result[0].id).toBe("c2");
    expect(result[0].page).toBe(2);
  });

  it("a boosted page the evidence endorses keeps its edge", async () => {
    // The boosted page (score 12) is ahead of the genuine hit (score 10).
    // The LLM rates BOTH highly (5, 5). The boosted page's small lexical edge
    // (12/12=1 vs 10/12≈0.83) plus equal LLM scores keeps it on top.
    const candidates = [
      { ...CHUNKS[0], score: 12, isBoosted: true },
      { ...CHUNKS[1], score: 10 },
    ];
    mockFetch.mockResolvedValue(llmResponse("[5, 5]"));
    const result = await rerank("key", "question", candidates);
    expect(result[0].id).toBe("c1"); // boosted page stays first
  });
});
