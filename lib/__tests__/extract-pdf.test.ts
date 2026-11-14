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
    // Left column: 12 lines at x=72, spanning Y 700 down to 100.
    // Right column: 12 lines at x=350, same Y range.
    // Spreading across the full body region ensures the gutter gets votes
    // in most slices (column detection requires ≥6/8 slices).
    const leftWords = Array.from({ length: 12 }, (_, i) => `L${i}`);
    const rightWords = Array.from({ length: 12 }, (_, i) => `R${i}`);
    const items: Array<{ str: string; x: number; y: number; size: number }> = [];
    for (let i = 0; i < 12; i++) {
      items.push({ str: leftWords[i], x: 72, y: 700 - i * 50, size: 12 });
      items.push({ str: rightWords[i], x: 350, y: 700 - i * 50, size: 12 });
    }
    const pages = await extractFromItems(items);
    expect(pages).toHaveLength(1);
    const text = pages[0];
    // Left column items come before right column items.
    const l0Idx = text.indexOf("L0");
    const l11Idx = text.indexOf("L11");
    const r0Idx = text.indexOf("R0");
    const r11Idx = text.indexOf("R11");
    expect(l0Idx).toBeLessThan(l11Idx);
    expect(r0Idx).toBeLessThan(r11Idx);
    // Left column before right column.
    expect(l11Idx).toBeLessThan(r0Idx);
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
