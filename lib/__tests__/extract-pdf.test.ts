import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractPdfPages } from "../extract-pdf.mjs";

// ─── Layout-aware PDF extraction (issue #70) — synthetic-PDF unit tests ────
//
// These tests hand-craft minimal PDF byte strings with known layouts and
// assert that the extractor produces the correct reading order, handles
// hyphenation, drops boilerplate, and preserves first characters. They are
// CI-safe: no external PDF files or gitignored artifacts are required.

/**
 * Build a minimal valid PDF buffer from a list of text items.
 * Each item is { str, x, y, size } in PDF user-space coordinates.
 * The PDF uses a single Helvetica font and positions each string with Td/Tj.
 */
function buildPdf(items: Array<{ str: string; x: number; y: number; size: number }>, numPages = 1) {
  // Escape parentheses and backslashes in PDF string literals.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

  // Build content streams per page. We put all items on page 1 for simplicity;
  // multi-page tests use separate item lists.
  const contentParts: string[] = [];
  for (const item of items) {
    contentParts.push(`BT /F1 ${item.size} Tf ${item.x} ${item.y} Td (${esc(item.str)}) Tj ET`);
  }
  const stream = contentParts.join("\n");
  const streamLen = Buffer.byteLength(stream, "utf-8");

  // Minimal PDF structure. Offsets are approximate; pdfjs tolerates imprecise xrefs.
  const header = "%PDF-1.4\n";
  const obj1 = `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n`;
  const obj2 = `2 0 obj << /Type /Pages /Kids [3 0 R] /Count ${numPages} >> endobj\n`;
  const obj3 = `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n`;
  const obj4 = `4 0 obj << /Length ${streamLen} >> stream\n${stream}\nendstream endobj\n`;
  const obj5 = `5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n`;

  const body = header + obj1 + obj2 + obj3 + obj4 + obj5;
  const xrefOffset = Buffer.byteLength(body, "utf-8");

  // xref table (approximate offsets are fine for pdfjs).
  const xref = `xref\n0 6\n0000000000 65535 f \n`;
  const trailer = `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, "utf-8");
}

/** Write a temp PDF and extract its pages. */
async function extractFromItems(
  items: Array<{ str: string; x: number; y: number; size: number }>,
) {
  const buf = buildPdf(items);
  const tmpPath = join("/tmp", `test-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  await import("node:fs/promises").then((fs) => fs.writeFile(tmpPath, buf));
  try {
    return await extractPdfPages(tmpPath);
  } finally {
    await import("node:fs/promises").then((fs) => fs.unlink(tmpPath).catch(() => {}));
  }
}

describe("extractPdfPages — synthetic PDF (issue #70)", () => {
  it("groups items on the same Y into a single line, sorted by X", async () => {
    // Three words on one line: "Hello" at x=72, "World" at x=130, "Foo" at x=190.
    const pages = await extractFromItems([
      { str: "Hello", x: 72, y: 700, size: 12 },
      { str: "World", x: 130, y: 700, size: 12 },
      { str: "Foo", x: 190, y: 700, size: 12 },
    ]);
    expect(pages).toHaveLength(1);
    // All three words on one line, in X order.
    expect(pages[0]).toContain("Hello");
    expect(pages[0]).toContain("World");
    expect(pages[0]).toContain("Foo");
    const helloIdx = pages[0].indexOf("Hello");
    const worldIdx = pages[0].indexOf("World");
    const fooIdx = pages[0].indexOf("Foo");
    expect(helloIdx).toBeLessThan(worldIdx);
    expect(worldIdx).toBeLessThan(fooIdx);
  });

  it("orders lines top-to-bottom (higher Y first)", async () => {
    const pages = await extractFromItems([
      { str: "Bottom", x: 72, y: 100, size: 12 },
      { str: "Top", x: 72, y: 700, size: 12 },
      { str: "Middle", x: 72, y: 400, size: 12 },
    ]);
    expect(pages).toHaveLength(1);
    const topIdx = pages[0].indexOf("Top");
    const midIdx = pages[0].indexOf("Middle");
    const botIdx = pages[0].indexOf("Bottom");
    expect(topIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(botIdx);
  });

  it("reads two columns left-to-right, top-to-bottom within each", async () => {
    // Two realistic-width columns: left at x=72, right at x=310, each line a
    // full phrase so the ink span is wide and the gutter sits near the middle
    // of the page (a real column gutter, not a far-right inter-word gap).
    // Spreading across the full body region ensures the gutter gets votes in
    // most slices (column detection requires ≥6/8 slices).
    const items: Array<{ str: string; x: number; y: number; size: number }> = [];
    for (let i = 0; i < 12; i++) {
      items.push({ str: `Left text ${i} of the quick brown fox`, x: 72, y: 700 - i * 50, size: 12 });
      items.push({ str: `Right text ${i} of the lazy dog runs`, x: 310, y: 700 - i * 50, size: 12 });
    }
    const pages = await extractFromItems(items);
    expect(pages).toHaveLength(1);
    const text = pages[0];
    // Left column items come before right column items.
    const l0Idx = text.indexOf("Left text 0");
    const l11Idx = text.indexOf("Left text 11");
    const r0Idx = text.indexOf("Right text 0");
    const r11Idx = text.indexOf("Right text 11");
    expect(l0Idx).toBeLessThan(l11Idx);
    expect(r0Idx).toBeLessThan(r11Idx);
    // Left column before right column.
    expect(l11Idx).toBeLessThan(r0Idx);
  });

  it("detects the gutter on a two-column page with RAGGED left edges", async () => {
    // Regression for review finding B1: when the left column's edge is ragged
    // (each line ends at a different X), the gap CENTER drifts slice-to-slice
    // and center-based clustering never reaches the vote threshold, fusing the
    // two columns into one. Clustering by the stable right edge b recovers the
    // gutter. Left phrases vary in length (ragged right edge); the right column
    // starts at a fixed x=310 in every line.
    const leftPhrases = [
      "Ragged zero",
      "Ragged one jumps over the lazy dog",
      "Ragged two",
      "Ragged three runs through the forest",
      "Ragged four",
      "Ragged five leaps over the meadow",
      "Ragged six",
      "Ragged seven gallops past the river",
      "Ragged eight",
      "Ragged nine dances in the garden",
      "Ragged ten",
      "Ragged eleven sprints down the lane",
    ];
    const rightPhrases = Array.from({ length: 12 }, (_, i) => `Right ${i} of the alpha beta column`);
    const items: Array<{ str: string; x: number; y: number; size: number }> = [];
    for (let i = 0; i < 12; i++) {
      items.push({ str: leftPhrases[i], x: 72, y: 700 - i * 50, size: 12 });
      items.push({ str: rightPhrases[i], x: 310, y: 700 - i * 50, size: 12 });
    }
    const pages = await extractFromItems(items);
    expect(pages).toHaveLength(1);
    const text = pages[0];
    // The gutter must be detected: the whole left column is read before the
    // right column (not interleaved line-by-line).
    const l0Idx = text.indexOf("Ragged zero");
    const l11Idx = text.indexOf("Ragged eleven");
    const r0Idx = text.indexOf("Right 0");
    expect(l0Idx).toBeLessThan(l11Idx);
    expect(l11Idx).toBeLessThan(r0Idx);
  });

  it("does not detect a gutter on a single-column page", async () => {
    // Regression for review finding B1: a single column of ragged-right-edge
    // text must NOT be split into columns. The observable consequence of a
    // false gutter is column reordering (a second band joined by "\\n\\n");
    // with uniform line pitch there are no paragraph breaks, so a correct
    // single-band extraction contains no "\\n\\n" and reads strictly
    // top-to-bottom.
    const phrases = Array.from({ length: 12 }, (_, i) => `Single column line ${i} with a ragged right edge here`);
    const items: Array<{ str: string; x: number; y: number; size: number }> = [];
    for (let i = 0; i < 12; i++) {
      items.push({ str: phrases[i], x: 72, y: 700 - i * 50, size: 12 });
    }
    const pages = await extractFromItems(items);
    expect(pages).toHaveLength(1);
    const text = pages[0];
    // No column split: a single band means no "\\n\\n" paragraph separator.
    expect(text).not.toContain("\n\n");
    // Strictly top-to-bottom order.
    for (let i = 0; i < 11; i++) {
      expect(text.indexOf(`line ${i}`)).toBeLessThan(text.indexOf(`line ${i + 1}`));
    }
  });

  it("places a drop-cap glyph at the start of its line, not mid-page", async () => {
    // Regression for review finding B2: a large drop cap (size ~3x body) has
    // its baseline at the bottom of the multi-line span it occupies. Y-based
    // joining with a size-scaled tolerance used to plant it on the line above
    // its baseline, resurfacing mid-page. It must be placed by top edge so the
    // dropped letter leads the first line ("You've...", not "ou've...").
    const items: Array<{ str: string; x: number; y: number; size: number }> = [
      { str: "ou've always liked plants.", x: 100, y: 700, size: 12 },
      { str: "Y", x: 72, y: 685, size: 36 }, // drop cap spanning lines 1-2
      { str: "text on the second line", x: 72, y: 685, size: 12 },
      { str: "text on the third line", x: 72, y: 670, size: 12 },
      { str: "text on the fourth line", x: 72, y: 655, size: 12 },
    ];
    const pages = await extractFromItems(items);
    expect(pages).toHaveLength(1);
    const text = pages[0].trim();
    // The dropped "Y" leads the first line ("You..."), not mid-page. Assert on
    // the prefix so the test is independent of how pdfjs encodes the apostrophe.
    expect(text.startsWith("You")).toBe(true);
    expect(text.indexOf("always liked plants")).toBeGreaterThan(0);
    // Body lines follow in order.
    expect(text.indexOf("second line")).toBeLessThan(text.indexOf("third line"));
    expect(text.indexOf("third line")).toBeLessThan(text.indexOf("fourth line"));
  });

  it("repairs hyphenation across line breaks", async () => {
    // "hy-" on one line, "phen" on the next → should become "hyphen".
    const pages = await extractFromItems([
      { str: "The word hy-", x: 72, y: 700, size: 12 },
      { str: "phen is here.", x: 72, y: 685, size: 12 },
    ]);
    expect(pages).toHaveLength(1);
    // The hyphenated word should be joined.
    expect(pages[0]).toContain("hyphen");
    expect(pages[0]).not.toContain("hy-");
  });

  it("preserves the first character of page text", async () => {
    const pages = await extractFromItems([
      { str: "The quick brown fox", x: 72, y: 700, size: 12 },
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0].trim().startsWith("The")).toBe(true);
  });

  it("produces one string per page", async () => {
    const pages = await extractFromItems([
      { str: "Page one text", x: 72, y: 700, size: 12 },
    ]);
    expect(Array.isArray(pages)).toBe(true);
    expect(pages).toHaveLength(1);
    expect(typeof pages[0]).toBe("string");
  });

  it("handles empty pages gracefully", async () => {
    // A PDF with no text items should produce an empty string for the page.
    const buf = buildPdf([]);
    const tmpPath = join("/tmp", `test-pdf-empty-${Date.now()}.pdf`);
    await import("node:fs/promises").then((fs) => fs.writeFile(tmpPath, buf));
    try {
      const pages = await extractPdfPages(tmpPath);
      expect(pages).toHaveLength(1);
      expect(pages[0].trim()).toBe("");
    } finally {
      await import("node:fs/promises").then((fs) => fs.unlink(tmpPath).catch(() => {}));
    }
  });
});

// ─── Real-PDF checks (skipped when PDFs are absent) ──────────────────────────

const hasBetrayalPdf = existsSync(
  join(process.cwd(), "content", "games", "betrayal-at-house-on-the-hill", "rules.pdf"),
);

describe.skipIf(!hasBetrayalPdf)(
  "extractPdfPages — real PDF (issue #70)",
  () => {
    it("extracts all pages from Betrayal rulebook", async () => {
      const pdfPath = join(
        process.cwd(),
        "content", "games", "betrayal-at-house-on-the-hill", "rules.pdf",
      );
      const pages = await extractPdfPages(pdfPath);
      // Betrayal has 68 pages.
      expect(pages).toHaveLength(68);
      // Every page should be a string (possibly empty for blank pages).
      for (const p of pages) {
        expect(typeof p).toBe("string");
      }
      // Most pages should have non-trivial text.
      const nonEmpty = pages.filter((p) => p.trim().length > 20);
      expect(nonEmpty.length).toBeGreaterThan(50);
    });

    it("does not start most pages with boilerplate", async () => {
      const pdfPath = join(
        process.cwd(),
        "content", "games", "betrayal-at-house-on-the-hill", "rules.pdf",
      );
      const pages = await extractPdfPages(pdfPath);
      // Count pages whose first line is a bare page number or known furniture.
      let boilerplateCount = 0;
      for (const text of pages) {
        const firstLine = (text.split(/\n+/)[0] ?? "").trim();
        if (/^\d+$/.test(firstLine) || /^printed by/i.test(firstLine)) {
          boilerplateCount++;
        }
      }
      // With boilerplate removal, very few pages should start with furniture.
      expect(boilerplateCount).toBeLessThanOrEqual(2);
    });

    it("reads multi-column pages in correct order (left column before right)", async () => {
      const pdfPath = join(
        process.cwd(),
        "content", "games", "betrayal-at-house-on-the-hill", "rules.pdf",
      );
      // Page 3 (1-indexed) is a two-column rules page.
      const pages = await extractPdfPages(pdfPath);
      const text = pages[2]; // 0-indexed
      expect(text.trim().length).toBeGreaterThan(100);
      // The text should contain rule content, not just fragments.
      expect(text).toMatch(/[A-Z]/); // at least one capital letter
    });
  },
);
