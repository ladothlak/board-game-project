import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { splitPassages } from "../passages.mjs";
import { retrieve, pageMap, type Chunk } from "../retrieve";
import { measureExcerptDelivery } from "../rag";

// ─── Passage chunking (issue #72, P1.3) ─────────────────────────────────────
//
// splitPassages turns a page's extracted text into 300–600-token passages at
// paragraph/heading boundaries with a ~12% overlap: the last N tokens of
// passage k are repeated verbatim at the start of passage k+1 (N = round(12%
// of the passage length), inside the plan's 10–15% band). These unit tests are
// CI-safe — pure functions over known texts, no index file or PDF required.

/** A paragraph of exactly `n` distinct words. */
function para(n: number, salt = 0): string {
  return Array.from({ length: n }, (_, j) => `w${salt}_${j}`).join(" ");
}

const OVERLAP_RATIO = 0.12; // the default splitPassages overlap (lib/passages.mjs)

/** Words of a flattened passage, for overlap comparison. */
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

describe("splitPassages — known text with paragraph breaks", () => {
  // 24 paragraphs × 50 tokens = 1200 tokens, joined by blank lines. Paragraph
  // starts sit at every multiple of 50, so the expected cuts are exact:
  //   p0: [0, 600)      — farthest boundary within 600 of 0
  //   p1: [528, 1100)   — 600 − round(0.12·600) = 528; farthest within 600
  //   p2: [1031, 1200)  — 1100 − round(0.12·572) = 1031; runs to page end
  const text = Array.from({ length: 24 }, (_, i) => para(50, i)).join("\n\n");

  it("splits into passages of 300–600 tokens (the last may be shorter)", () => {
    const passages = splitPassages(text);
    expect(passages.map((p) => p.tokenCount)).toEqual([600, 572, 169]);
    for (const [i, p] of passages.entries()) {
      if (i < passages.length - 1) {
        expect(p.tokenCount).toBeGreaterThanOrEqual(300);
        expect(p.tokenCount).toBeLessThanOrEqual(600);
      } else {
        expect(p.tokenCount).toBeGreaterThan(0);
      }
    }
  });

  it("cuts only at paragraph boundaries (never mid-paragraph)", () => {
    const passages = splitPassages(text);
    // Every cut point is a paragraph start: in this fixture those are the
    // multiples of 50. Passage k ends where passage k+1's pre-overlap content
    // begins, i.e. at token end_k = start_{k+1} + overlap_k.
    const paraStarts = new Set(Array.from({ length: 25 }, (_, i) => i * 50));
    let start = 0;
    for (const [i, p] of passages.entries()) {
      if (i === passages.length - 1) break;
      const end = start + p.tokenCount;
      expect(paraStarts.has(end)).toBe(true);
      start = end - Math.round(OVERLAP_RATIO * p.tokenCount);
    }
  });

  it("repeats the last N tokens of passage k at the start of passage k+1 (10–15%)", () => {
    const passages = splitPassages(text);
    for (let i = 0; i + 1 < passages.length; i++) {
      const len = passages[i].tokenCount;
      const n = Math.round(OVERLAP_RATIO * len);
      // The overlap fraction stays inside the plan's 10–15% band.
      expect(n / len).toBeGreaterThanOrEqual(0.1);
      expect(n / len).toBeLessThanOrEqual(0.15);
      // Exact verbatim repeat: last n tokens of k === first n tokens of k+1.
      const tail = words(passages[i].text).slice(-n);
      const head = words(passages[i + 1].text).slice(0, n);
      expect(head).toEqual(tail);
    }
  });

  it("keeps passages contiguous: no word is dropped from the page", () => {
    const passages = splitPassages(text);
    // The union of all passage words (overlap counted once) covers every word
    // of the page in order.
    const all = [passages[0].text, ...passages.slice(1).map((p) => p.text)];
    const joined = all.join(" ");
    expect(words(joined).length).toBeGreaterThanOrEqual(words(text).length);
    // And the first passage starts with the page's first word.
    expect(words(passages[0].text)[0]).toBe(words(text)[0]);
  });
});

describe("splitPassages — heading alignment", () => {
  it("cuts at a heading position when one sits on a boundary", () => {
    // 11 paragraphs × 50 tokens (550), then a heading of its own paragraph
    // (3 tokens, ending at token 553), then 13 more paragraphs. The farthest
    // boundary within 600 of 0 is 553 — right after the heading — so passage 0
    // ends exactly where the heading ends and the next passage starts in the
    // overlap before it.
    const text = [
      ...Array.from({ length: 11 }, (_, i) => para(50, i)),
      "Setup Instructions Here",
      ...Array.from({ length: 13 }, (_, i) => para(50, 100 + i)),
    ].join("\n\n");

    const passages = splitPassages(text);
    expect(passages[0].tokenCount).toBe(553);
    expect(passages[0].text.trim().endsWith("Setup Instructions Here")).toBe(true);
    // The heading is NOT split mid-way: it sits wholly in passage 0, and in
    // passage 1 it appears only inside the leading overlap (the last n tokens
    // of passage 0 repeated verbatim), never after it.
    const n = Math.round(OVERLAP_RATIO * passages[0].tokenCount);
    const head = words(passages[1].text).slice(0, n).join(" ");
    expect(head).toContain("Setup Instructions Here");
    expect(words(passages[1].text).slice(n).join(" ")).not.toContain("Setup Instructions Here");
  });
});

describe("splitPassages — degenerate inputs", () => {
  it("returns a single passage for text shorter than the minimum", () => {
    const text = Array.from({ length: 4 }, (_, i) => para(50, i)).join("\n\n"); // 200 tokens
    const passages = splitPassages(text);
    expect(passages).toHaveLength(1);
    expect(passages[0].tokenCount).toBe(200);
  });

  it("splits an unstructured blob (no newlines, no punctuation) by words", () => {
    // 1000 words, one space apart: the sentence/paragraph fallbacks find
    // nothing, so word boundaries carry the split.
    const text = Array.from({ length: 1000 }, (_, i) => `t${i}`).join(" ");
    const passages = splitPassages(text);
    expect(passages.map((p) => p.tokenCount)).toEqual([600, 472]);
    const n = Math.round(OVERLAP_RATIO * 600); // 72
    expect(words(passages[1].text).slice(0, n)).toEqual(words(passages[0].text).slice(-n));
  });

  it("splits an oversized single paragraph (no internal breaks) by words", () => {
    // One 1500-word blob, then a blank line and a 400-word paragraph. No
    // sentence punctuation anywhere, so the gap-aware fallback cuts the blob
    // at word boundaries — every non-final passage stays ≤ 600 tokens even
    // though the page DOES have paragraph structure elsewhere.
    const text = [para(1500, 0), para(400, 200)].join("\n\n");
    const passages = splitPassages(text);
    expect(passages.map((p) => p.tokenCount)).toEqual([600, 600, 444, 453]);
    for (const [i, p] of passages.entries()) {
      if (i < passages.length - 1) expect(p.tokenCount).toBeLessThanOrEqual(600);
    }
  });

  it("splits a giant paragraph at sentence starts when sentences fit", () => {
    // One 1500-word block with no blank lines; every 500th word ends in a
    // period, giving sentence starts at tokens 500 and 1000. The gap-aware
    // fallback cuts at those sentence starts — not at word boundaries.
    const sent = (n: number, salt: number) =>
      Array.from({ length: n }, (_, j) => (j === n - 1 ? `w${salt}_${j}.` : `w${salt}_${j}`)).join(" ");
    const text = [sent(500, 0), sent(500, 1), sent(500, 2)].join(" ");
    const passages = splitPassages(text);
    expect(passages.map((p) => p.tokenCount)).toEqual([500, 560, 567]);
  });

  it("returns no passages for empty or whitespace-only text", () => {
    expect(splitPassages("")).toEqual([]);
    expect(splitPassages(" \n\n ")).toEqual([]);
  });

  it("reports tokenCount as the approximate word count of the passage", () => {
    const text = Array.from({ length: 3 }, (_, i) => para(120, i)).join("\n\n"); // 360 tokens
    const passages = splitPassages(text);
    expect(passages).toHaveLength(1);
    expect(passages[0].tokenCount).toBe(words(text).length);
  });
});

// ─── Backward-compatible read path (issue #72) ──────────────────────────────
//
// The v3 index adds parentPage / passageIndex / tokenCount to every chunk.
// Consumers that only read `page` and `text` must keep working: retrieval,
// the page map, and excerpt delivery all run on a plain Chunk[].

const V3_CHUNKS: Chunk[] = [
  { id: "g-p1-s0", slug: "test-game", title: "T", page: 1, parentPage: 1, passageIndex: 0, tokenCount: 8, text: "Set up the board by placing the tokens." },
  { id: "g-p1-s1", slug: "test-game", title: "T", page: 1, parentPage: 1, passageIndex: 1, tokenCount: 8, text: "placing the tokens. Then deal the cards." },
  { id: "g-p2-s0", slug: "test-game", title: "T", page: 2, parentPage: 2, passageIndex: 0, tokenCount: 9, text: "The round has a setup phase and an end phase." },
];

describe("v3 chunk read path — consumers reading only page + text", () => {
  it("retrieve ranks v3 chunks by their text alone", () => {
    const hits = retrieve(V3_CHUNKS, "deal the cards");
    expect(hits.length).toBeGreaterThan(0);
    // Every hit exposes the fields a plain consumer reads: page and text.
    for (const h of hits) {
      expect(typeof h.page).toBe("number");
      expect(typeof h.text).toBe("string");
    }
  });

  it("pageMap labels each parentPage once, from its first passage", () => {
    const map = pageMap(V3_CHUNKS);
    expect(map).toHaveLength(2);
    expect(map[0]).toMatch(/^p\. 1: /);
    expect(map[1]).toMatch(/^p\. 2: /);
  });

  it("measureExcerptDelivery derives excerptedPages from parentPage", () => {
    const excerpts = [
      "--- Page 1 ---\nSet up the board by placing the tokens.",
      "--- Page 2 ---\nThe round has a setup phase and an end phase.",
    ].join("\n\n");
    const { excerptedPages, excerptCoverage } = measureExcerptDelivery(excerpts, V3_CHUNKS);
    expect(excerptedPages).toEqual([1, 2]);
    // Page 1's original length is the SUM of both passages, not passage 0.
    const p1Original = V3_CHUNKS[0].text.length + V3_CHUNKS[1].text.length;
    expect(excerptCoverage[1]).toBeCloseTo(V3_CHUNKS[0].text.length / p1Original, 5);
    expect(excerptCoverage[2]).toBe(1); // page 2 delivered in full
  });

  it("v1/v2 chunks (no parentPage) keep the old first-chunk convention", () => {
    const v1: Chunk[] = [
      { id: "g-1", slug: "test-game", title: "T", page: 1, text: "Set up the board by placing the tokens." },
    ];
    const excerpts = "--- Page 1 ---\nSet up";
    const { excerptedPages, excerptCoverage } = measureExcerptDelivery(excerpts, v1);
    expect(excerptedPages).toEqual([1]);
    // Denominator is the first (and only) chunk length — the old convention.
    expect(excerptCoverage[1]).toBeCloseTo(6 / v1[0].text.length, 5);
  });
});

// ─── Real index schema (issue #72) ─────────────────────────────────────────
//
// When a built search-index.json is present, every entry must carry the v3
// passage fields. Skipped in CI where no index has been built (same pattern as
// rag-expansion-gate.test.ts).

const INDEX_PATH = join(process.cwd(), "public", "search-index.json");
const hasIndex = existsSync(INDEX_PATH);

describe.skipIf(!hasIndex)("real search index — v3 passage schema", () => {
  it("schemaVersion is 3 and every chunk has the passage fields", () => {
    const raw = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
    expect(raw.schemaVersion).toBe(3);
    expect(raw.entries.length).toBeGreaterThan(0);
    for (const c of raw.entries) {
      expect(typeof c.parentPage).toBe("number");
      expect(c.page).toBe(c.parentPage); // citation unit stays the page
      expect(typeof c.sectionPath).toBe("string");
      expect(typeof c.tokenCount).toBe("number");
      expect(typeof c.passageIndex).toBe("number");
    }
  });
});
