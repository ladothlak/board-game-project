import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ocrPdfPages, OCR_PARTIAL_CHAR_THRESHOLD } from "../ocr-pdf.mjs";

// ─── OCR integration (issue #74, P1.5) — real gs + tesseract pipeline ────────
//
// Unlike ocr-pdf.test.ts (which mocks child_process for CI safety), this file
// runs the REAL pipeline against a local scanned rulebook: ghostscript renders
// every page and tesseract OCRs it. It is skipped when the rulebook is absent
// so it stays CI-safe, and its assertions hold whether or not tesseract is
// installed: full coverage (one entry per page, no cap) plus a consistent
// ocrPartial flag on every page whose text is empty or thin. Without tesseract
// every page comes back empty and flagged; with it, pages with real text are
// unflagged.

const hasMonopolyPdf = existsSync(
  join(process.cwd(), "content", "games", "monopoly", "rules.pdf"),
);
// The real pipeline needs gs (page rendering) and tesseract (OCR). Without
// either binary the test would fail on empty pages, so skip alongside the
// missing-PDF guard.
const hasGs = spawnSync("which", ["gs"]).status === 0;
const hasTesseract = spawnSync("which", ["tesseract"]).status === 0;

describe.skipIf(!hasMonopolyPdf || !hasGs || !hasTesseract)(
  "ocrPdfPages — real scanned PDF (issue #74)",
  () => {
    it("OCRs every page of the Monopoly rulebook with per-page partial flags", async () => {
      const pdfPath = join(process.cwd(), "content", "games", "monopoly", "rules.pdf");
      // The Monopoly rulebook has 8 pages. Full coverage means one entry per
      // page — no cap — and every entry whose text is empty or thin carries
      // ocrPartial: true.
      const pages = await ocrPdfPages(pdfPath);
      expect(pages.length).toBeGreaterThanOrEqual(8);
      for (const p of pages) {
        expect(typeof p.text).toBe("string");
        if (p.text.trim().length < OCR_PARTIAL_CHAR_THRESHOLD) {
          expect(p.ocrPartial).toBe(true);
        } else {
          expect(p.ocrPartial).toBeUndefined();
        }
      }
    }, 180_000);
  },
);
