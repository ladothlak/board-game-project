import { describe, it, expect } from "vitest";
import { buildPassageEntries } from "../index-entries.mjs";

// ─── Index entry schema (issue #74, P1.5) ─────────────────────────────────────
//
// buildPassageEntries is the single place that shapes search-index entries
// (extracted from scripts/build-index.mjs so the schema is unit-testable
// without running a full build). These tests pin down the `ocrPartial` field:
// it must be present (true) on every entry derived from a partially covered
// OCR page, and absent everywhere else, so consumers of public/search-index.json
// can tell which pages have incomplete coverage.

const LONG_TEXT = "Setup instructions for the game. ".repeat(40); // well over one passage

describe("buildPassageEntries — ocrPartial flag (issue #74)", () => {
  it("carries ocrPartial: true on every entry from a partially covered OCR page", () => {
    const pages = [
      { text: LONG_TEXT, ocrPartial: true },
      { text: "A second page of rules." },
    ];
    const entries = buildPassageEntries("test-game", "Test Game", pages, ["setup", "other"]);
    expect(entries.length).toBeGreaterThan(0);
    // Every entry from page 1 is flagged.
    const page1 = entries.filter((e) => e.page === 1);
    expect(page1.length).toBeGreaterThan(0);
    for (const e of page1) {
      expect(e.ocrPartial).toBe(true);
    }
    // No entry from page 2 is flagged.
    const page2 = entries.filter((e) => e.page === 2);
    expect(page2.length).toBeGreaterThan(0);
    for (const e of page2) {
      expect(e.ocrPartial).toBeUndefined();
    }
  });

  it("omits ocrPartial for text-layer pages and fully covered OCR pages", () => {
    const pages = [
      { text: LONG_TEXT }, // text layer: no flag at all
      { text: LONG_TEXT, ocrPartial: false as unknown as boolean }, // explicitly not partial
    ];
    const entries = buildPassageEntries("g", "G", pages, ["a", "b"]);
    for (const e of entries) {
      expect(e.ocrPartial).toBeUndefined();
    }
  });

  it("creates no entries for empty pages, even partially covered ones", () => {
    // An empty OCR page yields no passages, so there is no entry to flag — the
    // partial state of such a page lives in the extraction cache instead.
    const pages = [
      { text: "", ocrPartial: true },
      { text: "Some rule text here." },
    ];
    const entries = buildPassageEntries("g", "G", pages, ["a", "b"]);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.page).toBe(2);
      expect(e.ocrPartial).toBeUndefined();
    }
  });

  it("keeps the v3 passage schema fields on every entry", () => {
    const pages = [{ text: LONG_TEXT, ocrPartial: true }];
    const entries = buildPassageEntries("slug-x", "Title X", pages, ["setup"]);
    for (const e of entries) {
      expect(e.id).toMatch(/^slug-x-p1-s\d+$/);
      expect(e.slug).toBe("slug-x");
      expect(e.title).toBe("Title X");
      expect(e.page).toBe(1);
      expect(e.parentPage).toBe(1);
      expect(typeof e.passageIndex).toBe("number");
      expect(typeof e.tokenCount).toBe("number");
      expect(typeof e.text).toBe("string");
      expect(e.text.length).toBeGreaterThan(0);
      expect(e.isExpansion).toBe(false);
      expect(e.sectionPath).toBe("setup");
      expect(Array.isArray(e.headings)).toBe(true);
    }
  });

  it("propagates heading text from the page onto its entries", () => {
    const pages = [{ text: LONG_TEXT, headings: [{ text: "Setup" }] }];
    const entries = buildPassageEntries("g", "G", pages, ["setup"]);
    for (const e of entries) {
      expect(e.headings).toEqual(["Setup"]);
    }
  });
});
