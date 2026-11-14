import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  startsWithMidWord,
  startsWithBoilerplate,
  hasNoText,
  isDuplicatePage,
  computeGameHealth,
  findFailingGames,
} from "../page-health.mjs";
import { extractPdfPagesWithHeadings } from "../extract-pdf.mjs";

// ─── Extraction health checks (issue #73, P1.4) ──────────────────────────────
//
// These unit tests are CI-safe: pure functions over known page texts, no PDF or
// index file required. The per-page predicates reuse the heuristics from
// scripts/measure-extraction.mjs, so the assertions below mirror that script's
// documented behavior (mid-word is an upper bound on true corruption).

describe("startsWithMidWord (issue #73)", () => {
  it("flags a lowercase first character (mid-word start)", () => {
    expect(startsWithMidWord("he wall in front of you")).toBe(true);
    expect(startsWithMidWord("setup instructions for the game")).toBe(true);
  });

  it("does not flag an uppercase first character", () => {
    expect(startsWithMidWord("Setup instructions for the game")).toBe(false);
    expect(startsWithMidWord("The quick brown fox jumps over the lazy dog.")).toBe(false);
  });

  it("returns false for empty or whitespace-only text", () => {
    expect(startsWithMidWord("")).toBe(false);
    expect(startsWithMidWord("   ")).toBe(false);
  });

  it("ignores leading whitespace before the first letter", () => {
    expect(startsWithMidWord("   lowercase start")).toBe(true);
    expect(startsWithMidWord("   Uppercase start")).toBe(false);
  });
});

describe("startsWithBoilerplate (issue #73)", () => {
  it("flags a bare page number", () => {
    expect(startsWithBoilerplate("12\nThe rest of the page text.")).toBe(true);
    expect(startsWithBoilerplate("3")).toBe(true);
  });

  it('flags "Printed by" running heads', () => {
    expect(startsWithBoilerplate("Printed by Acme Print Co.\nBody text here.")).toBe(true);
    expect(startsWithBoilerplate("printed by someone else")).toBe(true);
  });

  it('flags a "flat sheet" running head', () => {
    expect(startsWithBoilerplate('12" x 9" flat sheet folded to 6" x 9" 4C2S\nBody text.')).toBe(true);
  });

  it("flags an InDesign job name (.indd)", () => {
    expect(startsWithBoilerplate("job.indd:page 12\nBody text.")).toBe(true);
  });

  it("does not flag ordinary rulebook text", () => {
    expect(startsWithBoilerplate("Setup: place the board in the center of the table.")).toBe(false);
    expect(startsWithBoilerplate("Combat rules apply on every turn of play.")).toBe(false);
  });

  it("counts an empty page as boilerplate (no real leading content)", () => {
    expect(startsWithBoilerplate("")).toBe(true);
    expect(startsWithBoilerplate("\n\n")).toBe(true);
  });
});

describe("hasNoText (issue #73)", () => {
  it("flags empty and short pages (< 20 trimmed chars)", () => {
    expect(hasNoText("")).toBe(true);
    expect(hasNoText("   ")).toBe(true);
    expect(hasNoText("12")).toBe(true);
    expect(hasNoText("setup")).toBe(true); // 5 chars
  });

  it("does not flag pages with >= 20 trimmed chars", () => {
    expect(hasNoText("This page has enough text to retrieve.")).toBe(false);
    expect(hasNoText("  exactly twenty characters  ")).toBe(false); // 24 trimmed
  });
});

describe("isDuplicatePage (issue #73)", () => {
  it("flags an identical page", () => {
    const pages = [
      "The rules of the game are simple and easy to follow for all players.",
      "The rules of the game are simple and easy to follow for all players.",
    ];
    expect(isDuplicatePage(pages, 0)).toBe(true);
    expect(isDuplicatePage(pages, 1)).toBe(true);
  });

  it("flags a >95%-similar page (one extra trailing word)", () => {
    // ~320 chars of distinct tokens; the second adds one word (~2% longer), so the
    // length prefilter passes and the Dice bigram ratio is well above 0.95.
    const a = Array.from({ length: 40 }, (_, i) => `token${i}`).join(" ");
    const b = `${a} extra`;
    expect(isDuplicatePage([a, b], 0)).toBe(true);
    expect(isDuplicatePage([a, b], 1)).toBe(true);
  });

  it("does not flag genuinely different pages", () => {
    const a = Array.from({ length: 40 }, (_, i) => `alpha${i}`).join(" ");
    const b = Array.from({ length: 40 }, (_, i) => `beta${i}`).join(" ");
    expect(isDuplicatePage([a, b], 0)).toBe(false);
    expect(isDuplicatePage([a, b], 1)).toBe(false);
  });

  it("never treats a short page (< 20 chars) as a duplicate", () => {
    // A blank/short page is flagged only by hasNoText, not doubled up here.
    const pages = ["", "This is a long enough page of real rulebook text content."];
    expect(isDuplicatePage(pages, 0)).toBe(false);
  });

  it("does not flag a single-page game (no other page to compare)", () => {
    const pages = ["A single page with plenty of unique rulebook text inside."];
    expect(isDuplicatePage(pages, 0)).toBe(false);
  });
});

describe("computeGameHealth (issue #73)", () => {
  it("scores a clean game at 1.0", () => {
    const pages = [
      "Setup instructions for the game begin here with clear steps.",
      "Combat rules: attack and defend each turn with your units.",
      "Victory is reached when a player reaches the final goal.",
    ];
    const h = computeGameHealth(pages);
    expect(h.totalPages).toBe(3);
    expect(h.midWord).toBe(0);
    expect(h.boilerplate).toBe(0);
    expect(h.noText).toBe(0);
    expect(h.duplicates).toBe(0);
    expect(h.passing).toBe(3);
    expect(h.score).toBe(1);
  });

  it("counts each failing check and scores the clean fraction", () => {
    const pages = [
      "Setup instructions for the game begin here with clear steps.", // clean
      "setup", // mid-word + no-text (5 chars)
      "12", // boilerplate + no-text
      "", // boilerplate + no-text
      "Combat rules: attack and defend each turn with your units.", // clean
    ];
    const h = computeGameHealth(pages);
    expect(h.totalPages).toBe(5);
    expect(h.midWord).toBe(1); // "setup"
    expect(h.boilerplate).toBe(2); // "12", ""
    expect(h.noText).toBe(3); // "setup", "12", ""
    expect(h.duplicates).toBe(0);
    expect(h.passing).toBe(2); // the two clean pages
    expect(h.score).toBeCloseTo(0.4, 5);
  });

  it("counts a duplicated page once in `passing` even if it also fails another check", () => {
    // Page 1 is identical to page 0 (duplicate) AND starts mid-word; it must be
    // counted as failing exactly once for the score.
    const pages = [
      "The rules of the game are simple and easy to follow for all players.",
      "the rules of the game are simple and easy to follow for all players",
    ];
    const h = computeGameHealth(pages);
    expect(h.duplicates).toBe(2); // both pages are duplicates of each other
    expect(h.midWord).toBe(1); // only page 1 starts lowercase
    expect(h.passing).toBe(0);
    expect(h.score).toBe(0);
  });

  it("scores an empty game (no pages) at 1.0", () => {
    const h = computeGameHealth([]);
    expect(h.totalPages).toBe(0);
    expect(h.passing).toBe(0);
    expect(h.score).toBe(1);
  });
});

describe("findFailingGames — threshold gate (issue #73)", () => {
  it("returns only the games below the threshold", () => {
    const reports = [
      { slug: "good", totalPages: 10, score: 0.9 },
      { slug: "edge", totalPages: 10, score: 0.8 }, // exactly at threshold → passes
      { slug: "bad", totalPages: 10, score: 0.5 },
    ];
    const failing = findFailingGames(reports, 80);
    expect(failing.map((r) => r.slug)).toEqual(["bad"]);
  });

  it("skips zero-page games so a rulebook-less game never fails the build", () => {
    const reports = [
      { slug: "no-pdf", totalPages: 0, score: 1 },
      { slug: "bad", totalPages: 5, score: 0.2 },
    ];
    const failing = findFailingGames(reports, 80);
    expect(failing.map((r) => r.slug)).toEqual(["bad"]);
  });

  it("returns an empty list when every game is at or above the threshold", () => {
    const reports = [
      { slug: "a", totalPages: 4, score: 1 },
      { slug: "b", totalPages: 8, score: 0.95 },
    ];
    expect(findFailingGames(reports, 80)).toEqual([]);
  });

  it("respects a stricter threshold", () => {
    const reports = [
      { slug: "a", totalPages: 4, score: 0.85 },
      { slug: "b", totalPages: 8, score: 0.95 },
    ];
    expect(findFailingGames(reports, 90).map((r) => r.slug)).toEqual(["a"]);
  });
});

// ─── Integration: known-good real PDF + known-bad synthetic case ─────────────
//
// The known-good case runs the health check on a real rulebook (Betrayal, which
// P1.1 fixed) and asserts it passes its own threshold. It is skipped in CI where
// the PDF is absent (same pattern as extract-pdf.test.ts). The known-bad case is
// synthetic and always runs.

const hasBetrayalPdf = existsSync(
  join(process.cwd(), "content", "games", "betrayal-at-house-on-the-hill", "rules.pdf"),
);

describe.skipIf(!hasBetrayalPdf)("health check — known-good real PDF (issue #73)", () => {
  it("Betrayal passes its own health threshold after P1.1", async () => {
    const pdfPath = join(
      process.cwd(),
      "content", "games", "betrayal-at-house-on-the-hill", "rules.pdf",
    );
    const pages = await extractPdfPagesWithHeadings(pdfPath);
    expect(pages.length).toBeGreaterThanOrEqual(60);
    const health = computeGameHealth(pages.map((p) => p.text));
    // Betrayal's extraction (post P1.1) must clear the default 80% threshold: no
    // page starts with print boilerplate, and only a few mid-word/duplicate flags
    // remain (the mid-word check is an upper bound).
    expect(health.score).toBeGreaterThanOrEqual(0.8);
    expect(health.boilerplate).toBeLessThanOrEqual(2);
  });
});

describe("health check — known-bad synthetic case (issue #73)", () => {
  it("flags a heavily corrupted game and fails its threshold", () => {
    // A synthetic rulebook where most pages are corrupted: mid-word starts,
    // boilerplate page numbers, blank pages, and a duplicated spread.
    const pages = [
      "the wall in front of you is the only barrier between you", // mid-word
      "opy lengths of muscled tissue across the table", // mid-word
      "42", // boilerplate + no-text
      "", // no-text + boilerplate
      "setup instructions for the game begin here with clear steps.", // clean
    ];
    const health = computeGameHealth(pages);
    expect(health.totalPages).toBe(5);
    expect(health.midWord).toBeGreaterThanOrEqual(2);
    expect(health.boilerplate).toBeGreaterThanOrEqual(1);
    expect(health.noText).toBeGreaterThanOrEqual(2);
    // Most pages fail → the score is well below the default 80% threshold.
    expect(health.score).toBeLessThan(0.5);
    expect(findFailingGames([{ slug: "bad", ...health }], 80)).toHaveLength(1);
  });
});
