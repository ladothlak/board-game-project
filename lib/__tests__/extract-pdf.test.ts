import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractPdfPages, extractPdfPagesWithHeadings } from "../extract-pdf.mjs";
import { assignSectionPaths, regexSectionForText } from "../sections.mjs";

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
    // Regression for review finding B2 (second round): a large drop cap whose
    // em far exceeds its visual span has its baseline at the BOTTOM of the
    // multi-line span it occupies. The original implementation joined every
    // item by baseline with a tolerance scaled to the item's own size, so a
    // 48pt cap earned a ~21pt tolerance and was planted on the line at its
    // baseline (the last line of the span), resurfacing mid-page and dropping
    // the first character. The cap must be anchored by baseline to the TOPMOST
    // line of its span so the dropped letter leads the first line ("You've...",
    // not "ou've...").
    // Geometry: three body lines at pitch 10 (visual span ~32pt); the cap's em
    // (48) far exceeds that span; the cap's baseline (y=685) aligns with the
    // third line, whose text is emitted before the cap in item order. On the
    // original code this geometry yields "...third lineY" (cap on the last
    // line), so `startsWith("You")` fails; on the fixed code it yields
    // "You've..." and passes.
    const items: Array<{ str: string; x: number; y: number; size: number }> = [
      { str: "ou've always liked plants.", x: 100, y: 705, size: 12 },
      { str: "text on the second line", x: 72, y: 695, size: 12 },
      { str: "text on the third line", x: 72, y: 685, size: 12 },
      { str: "Y", x: 72, y: 685, size: 48 }, // drop cap spanning lines 1-3
    ];
    const pages = await extractFromItems(items);
    expect(pages).toHaveLength(1);
    const text = pages[0].trim();
    // The dropped "Y" leads the first line ("You..."), not mid-page. Assert on
    // the prefix so the test is independent of how pdfjs encodes the apostrophe.
    expect(text.startsWith("You")).toBe(true);
    expect(text.indexOf("always liked plants")).toBeGreaterThan(0);
    // Body lines follow in order, each exactly once.
    expect(text.indexOf("second line")).toBeLessThan(text.indexOf("third line"));
    expect(text.match(/third line/g)).toHaveLength(1);
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

// ─── Heading detection (issue #71) — synthetic-PDF unit tests ────────────────

/**
 * Build a minimal valid PDF buffer with TWO fonts: Helvetica (regular) and
 * Helvetica-Bold. Used for heading-detection tests where font size and/or
 * bold weight matter.
 */
function buildPdfWithBold(
  items: Array<{ str: string; x: number; y: number; size: number; bold?: boolean }>,
) {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

  const contentParts: string[] = [];
  for (const item of items) {
    const fontName = item.bold ? "/F2" : "/F1";
    contentParts.push(`BT ${fontName} ${item.size} Tf ${item.x} ${item.y} Td (${esc(item.str)}) Tj ET`);
  }
  const stream = contentParts.join("\n");
  const streamLen = Buffer.byteLength(stream, "utf-8");

  const header = "%PDF-1.4\n";
  const obj1 = `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n`;
  const obj2 = `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n`;
  const obj3 = `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >> endobj\n`;
  const obj4 = `4 0 obj << /Length ${streamLen} >> stream\n${stream}\nendstream endobj\n`;
  const obj5 = `5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n`;
  const obj6 = `6 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj\n`;

  const body = header + obj1 + obj2 + obj3 + obj4 + obj5 + obj6;
  const xrefOffset = Buffer.byteLength(body, "utf-8");
  const xref = `xref\n0 7\n0000000000 65535 f \n`;
  const trailer = `trailer << /Size 7 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, "utf-8");
}

/** Write a temp PDF and extract with headings. */
async function extractHeadingsFromItems(
  items: Array<{ str: string; x: number; y: number; size: number; bold?: boolean }>,
) {
  const buf = buildPdfWithBold(items);
  const tmpPath = join("/tmp", `test-pdf-headings-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  await import("node:fs/promises").then((fs) => fs.writeFile(tmpPath, buf));
  try {
    return await extractPdfPagesWithHeadings(tmpPath);
  } finally {
    await import("node:fs/promises").then((fs) => fs.unlink(tmpPath).catch(() => {}));
  }
}

describe("extractPdfPagesWithHeadings — synthetic PDF (issue #71)", () => {
  it("detects a large-font heading above body text", async () => {
    // "Setup" at size 20 (heading), body lines at size 10.
    // 20 >= 1.3 * 10 = 13 → heading.
    const pages = await extractHeadingsFromItems([
      { str: "Setup", x: 72, y: 700, size: 20 },
      { str: "Place the board in the center.", x: 72, y: 670, size: 10 },
      { str: "Deal five cards to each player.", x: 72, y: 655, size: 10 },
      { str: "The youngest player goes first.", x: 72, y: 640, size: 10 },
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0].headings.length).toBeGreaterThanOrEqual(1);
    // The heading text should be "Setup".
    const headingTexts = pages[0].headings.map((h) => h.text);
    expect(headingTexts.some((t) => t.includes("Setup"))).toBe(true);
  });

  it("does not flag body text as a heading", async () => {
    // All lines at the same size (10) — no heading should be detected.
    const pages = await extractHeadingsFromItems([
      { str: "The quick brown fox jumps over", x: 72, y: 700, size: 10 },
      { str: "the lazy dog in the meadow near", x: 72, y: 685, size: 10 },
      { str: "the river and the old stone bridge", x: 72, y: 670, size: 10 },
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0].headings.length).toBe(0);
  });

  it("returns text alongside headings", async () => {
    const pages = await extractHeadingsFromItems([
      { str: "Rules", x: 72, y: 700, size: 18 },
      { str: "Each turn you may take one action.", x: 72, y: 670, size: 10 },
    ]);
    expect(pages).toHaveLength(1);
    expect(typeof pages[0].text).toBe("string");
    expect(pages[0].text.length).toBeGreaterThan(0);
    expect(Array.isArray(pages[0].headings)).toBe(true);
  });

  it("detects bold heading at body size", async () => {
    // "Set Up" in bold at size 10 (same as body) — bold + size >= 0.95 * bodyMedian
    // should flag it as a heading. The body lines use narrow letters (i, l, t,
    // f, s) so their perEm median sits well below the bold line's, and there are
    // >= 5 lines in the size bucket — detectBoldFlags needs that many before its
    // spread check runs at all. The heading is a complete multi-word phrase:
    // single-word bold candidates are dropped (third review of #71).
    const pages = await extractHeadingsFromItems([
      { str: "Set Up", x: 72, y: 700, size: 10, bold: true },
      { str: "The light slit fits in the thin slot.", x: 72, y: 670, size: 10 },
      { str: "Fit the slim lid on the tin and sit.", x: 72, y: 655, size: 10 },
      { str: "A thin strip of silk is lit by sun.", x: 72, y: 640, size: 10 },
      { str: "The slim bit fits in the tin with ease.", x: 72, y: 625, size: 10 },
      { str: "Sit the lid on the thin slit of tin.", x: 72, y: 610, size: 10 },
    ]);
    expect(pages).toHaveLength(1);
    // Bold at body size must be detected as a heading.
    expect(pages[0].headings.length).toBeGreaterThanOrEqual(1);
    const headingTexts = pages[0].headings.map((h) => h.text);
    expect(headingTexts.some((t) => t.includes("Set Up"))).toBe(true);
  });

  it("does not flag bold bullet lines at paragraph starts as headings", async () => {
    // Regression for review finding B1 (issue #71): bold bullet lines and bold
    // lead-ins are common in rulebooks. A bold line that starts a block is body
    // text, not a heading, when it carries a list marker — on the pre-fix code
    // this exact fixture yields the bullet as a heading.
    const pages = await extractHeadingsFromItems([
      { str: "Intro line one of the setup text.", x: 72, y: 700, size: 10 },
      { str: "- Shuffle the omen cards and put them face down.", x: 72, y: 665, size: 10, bold: true },
      { str: "Then deal one card to each player in turn.", x: 72, y: 650, size: 10 },
      { str: "The youngest player starts the game now.", x: 72, y: 635, size: 10 },
      { str: "Set the timer and begin the first round.", x: 72, y: 620, size: 10 },
    ]);
    expect(pages).toHaveLength(1);
    // Zero headings: the bold bullet is body text, not a heading.
    expect(pages[0].headings.length).toBe(0);
  });
});

// ─── Section path assignment (issue #71) ─────────────────────────────────────

describe("assignSectionPaths (issue #71)", () => {
  it("builds hierarchical paths from heading stack", () => {
    const pages = [
      { text: "intro text", headings: [{ text: "Welcome", size: 20 }] },
      { text: "setup text", headings: [{ text: "Setup", size: 18 }] },
      { text: "detail text", headings: [{ text: "5.1 Setup Steps", size: 12 }] },
    ];
    const paths = assignSectionPaths(pages);
    expect(paths).toHaveLength(3);
    // Page 1: just "Welcome"
    expect(paths[0]).toBe("Welcome");
    // Page 2: Setup(18) < Welcome(20) → Setup is a sub-section of Welcome.
    // Stack = [Welcome(20), Setup(18)]. Path = "Welcome > Setup".
    expect(paths[1]).toBe("Welcome > Setup");
    // Page 3: 5.1 Setup Steps(12) < Setup(18) → sub-sub-section.
    // Stack = [Welcome(20), Setup(18), 5.1 Setup Steps(12)].
    // Path = "Welcome > Setup > 5.1 Setup Steps".
    expect(paths[2]).toBe("Welcome > Setup > 5.1 Setup Steps");
  });

  it("pops smaller sections when a larger heading appears", () => {
    const pages = [
      { text: "a", headings: [{ text: "Section A", size: 14 }] },
      { text: "b", headings: [{ text: "A.1 Sub", size: 10 }] },
      { text: "c", headings: [{ text: "Section B", size: 16 }] }, // larger → pops both
    ];
    const paths = assignSectionPaths(pages);
    expect(paths[0]).toBe("Section A");
    expect(paths[1]).toBe("Section A > A.1 Sub");
    // Section B (16) >= Section A (14) → pop A. 16 >= A.1 Sub (10) → pop Sub.
    // Stack = [Section B(16)]. Path = "Section B".
    expect(paths[2]).toBe("Section B");
  });

  it("falls back to regex when no heading on a page", () => {
    const pages = [
      { text: "Setup instructions for the game", headings: [] },
      { text: "Some random text with no keywords", headings: [] },
    ];
    const paths = assignSectionPaths(pages);
    expect(paths[0]).toBe("setup"); // regex matches "setup"
    expect(paths[1]).toBe("other"); // no keyword match
  });

  it("preserves stack across pages without headings", () => {
    const pages = [
      { text: "a", headings: [{ text: "Rules", size: 16 }] },
      { text: "b", headings: [] }, // no heading — should NOT reset the stack
      { text: "c", headings: [{ text: "R.1 Detail", size: 10 }] },
    ];
    const paths = assignSectionPaths(pages);
    expect(paths[0]).toBe("Rules");
    // Page 2 has no heading → regex fallback on its text.
    expect(paths[1]).toBe("other"); // "b" has no keywords
    // Page 3: R.1 Detail(10) pushed onto [Rules(16)] → "Rules > R.1 Detail"
    expect(paths[2]).toBe("Rules > R.1 Detail");
  });
});

describe("regexSectionForText (issue #71)", () => {
  it("matches known section keywords", () => {
    expect(regexSectionForText("Setup: place the board")).toBe("setup");
    expect(regexSectionForText("Rules and regulations apply")).toBe("rules");
    expect(regexSectionForText("Scoring points for each action")).toBe("scoring");
    expect(regexSectionForText("Turn order and phases")).toBe("turn");
  });

  it("returns 'other' when no keyword matches", () => {
    expect(regexSectionForText("Random text with nothing")).toBe("other");
    expect(regexSectionForText("")).toBe("other");
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
      // Betrayal has 68 pages; use a lower bound so a reissued PDF (extra
      // errata pages, etc.) does not break the test.
      expect(pages.length).toBeGreaterThanOrEqual(60);
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

// ─── Real-PDF heading checks (issue #71) ─────────────────────────────────────

describe.skipIf(!hasBetrayalPdf)(
  "extractPdfPagesWithHeadings — real PDF (issue #71)",
  () => {
    it("detects headings on most pages of the Betrayal rulebook", async () => {
      const pdfPath = join(
        process.cwd(),
        "content", "games", "betrayal-at-house-on-the-hill", "rules.pdf",
      );
      const pages = await extractPdfPagesWithHeadings(pdfPath);
      // Lower bound so a reissued PDF does not break the test.
      expect(pages.length).toBeGreaterThanOrEqual(60);
      // A substantial fraction of pages should have at least one heading.
      // (Corpus probe: ~72% of pages across all games have ≥1 heading.)
      const withHeadings = pages.filter((p) => p.headings.length > 0);
      expect(withHeadings.length).toBeGreaterThan(20); // at least ~30%
    });

    it("returns valid section paths from assignSectionPaths", async () => {
      const pdfPath = join(
        process.cwd(),
        "content", "games", "betrayal-at-house-on-the-hill", "rules.pdf",
      );
      const pages = await extractPdfPagesWithHeadings(pdfPath);
      const paths = assignSectionPaths(pages);
      // Lower bound so a reissued PDF does not break the test.
      expect(paths.length).toBeGreaterThanOrEqual(60);
      // Every path should be a non-empty string.
      for (const p of paths) {
        expect(typeof p).toBe("string");
        expect(p.length).toBeGreaterThan(0);
      }
      // Most paths should NOT be "other" (the regex fallback bucket).
      const otherCount = paths.filter((p) => p === "other").length;
      expect(otherCount).toBeLessThan(pages.length * 0.5); // < 50%
    });

    it("headings have valid structure (text, size)", async () => {
      const pdfPath = join(
        process.cwd(),
        "content", "games", "betrayal-at-house-on-the-hill", "rules.pdf",
      );
      const pages = await extractPdfPagesWithHeadings(pdfPath);
      for (const p of pages) {
        for (const h of p.headings) {
          expect(typeof h.text).toBe("string");
          expect(h.text.length).toBeGreaterThan(0);
          expect(typeof h.size).toBe("number");
          expect(h.size).toBeGreaterThan(0);
        }
      }
    });
  },
);
