import { describe, it, expect, vi } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ─── OCR fallback (issue #74, P1.5) — CI-safe unit tests ─────────────────────
//
// These tests mock the gs/tesseract child_process calls so no system binaries
// are required, and hand-craft a multi-page PDF that pdfjs can parse to report
// `doc.numPages`. They pin down the two behaviors issue #74 requires:
//   - every page of a scanned PDF is OCR'd — there is no page cap (the old
//     maxPages: 12 limit must not stop the loop early), and
//   - pages whose OCR text is empty or very short (< 50 chars) carry
//     `ocrPartial: true` so downstream consumers know coverage is incomplete.

/** Per-page tesseract output for the mocked runs, keyed by 1-based page number. */
const tessTexts: Record<number, string> = {};
/** Page numbers on which the mocked gs render fails (no PNG written). */
let gsFailsFrom = Infinity;

// The mocked execFile is a vi.fn so tests can inspect its call log. It is
// hoisted because the vi.mock factory below must reference it at evaluation
// time; tessTexts/gsFailsFrom are only read at call time, after module init.
const { execFileMock } = vi.hoisted(() => {
  const execFileMock = vi.fn(
    (cmd: string, args: string[], cb: (err: unknown, out: string, errOut: string) => void) => {
      if (cmd === "gs") {
        // Simulate a successful single-page render: write the output PNG.
        const outIdx = args.indexOf("-o");
        const firstPageArg = args.find((a) => a.startsWith("-dFirstPage="));
        if (!firstPageArg) {
          cb(Object.assign(new Error("missing -dFirstPage"), { code: 1 }), "", "");
          return;
        }
        const pageNum = Number(firstPageArg.slice("-dFirstPage=".length));
        if (pageNum < gsFailsFrom) {
          try {
            writeFileSync(args[outIdx + 1], "");
          } catch {
            /* tmp dir gone */
          }
          cb(null, "", "gs banner");
        } else {
          cb(Object.assign(new Error("no such page"), { code: 1 }), "", "gs: no page");
        }
      } else if (cmd === "tesseract") {
        // Simulate OCR: return the canned text for this page's PNG.
        const m = /page-(\d+)\.png$/.exec(args[0]);
        cb(null, tessTexts[m ? Number(m[1]) : 0] ?? "", "");
      } else {
        cb(Object.assign(new Error(`unexpected command ${cmd}`), { code: 1 }), "", "");
      }
    },
  );
  return { execFileMock };
});

vi.mock("child_process", () => ({ execFile: execFileMock }));

import { ocrPdfPages, OCR_PARTIAL_CHAR_THRESHOLD } from "../ocr-pdf.mjs";

/**
 * Build a minimal valid N-page PDF buffer. Each page carries one text item so
 * pdfjs reports `numPages === N`. Mirrors the synthetic-PDF builder in
 * extract-pdf.test.ts (pdfjs tolerates imprecise xrefs).
 */
function buildMultiPagePdf(numPages: number) {
  const header = "%PDF-1.4\n";
  const kids = Array.from({ length: numPages }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  let body =
    header +
    `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
    `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${numPages} >> endobj\n`;
  for (let i = 0; i < numPages; i++) {
    const pageObjNum = 3 + i * 2;
    const contentObjNum = pageObjNum + 1;
    const stream = `BT /F1 12 Tf 72 700 Td (Page ${i + 1} text) Tj ET`;
    const streamLen = Buffer.byteLength(stream, "utf-8");
    body +=
      `${pageObjNum} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentObjNum} 0 R /Resources << /Font << /F1 ${3 + numPages * 2} 0 R >> >> >> endobj\n` +
      `${contentObjNum} 0 obj << /Length ${streamLen} >> stream\n${stream}\nendstream endobj\n`;
  }
  const fontObjNum = 3 + numPages * 2;
  body += `${fontObjNum} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n`;
  const xrefOffset = Buffer.byteLength(body, "utf-8");
  const totalObjs = fontObjNum;
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjs; i++) xref += `0000000000 65535 f \n`;
  const trailer = `trailer << /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, "utf-8");
}

/** Write a temp PDF, run ocrPdfPages on it, and clean up. */
async function ocrTempPdf(buf: Buffer) {
  const tmpPath = join("/tmp", `test-ocr-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(tmpPath, buf);
  try {
    return await ocrPdfPages(tmpPath);
  } finally {
    unlinkSync(tmpPath);
  }
}

const LONG_TEXT = "The quick brown fox jumps over the lazy dog near the river and the old stone bridge.";

describe("ocrPdfPages — mocked gs/tesseract (issue #74)", () => {
  it("OCRs every page of the document — no page cap", async () => {
    // 15 pages: more than the old maxPages: 12 cap, so the pre-fix loop would
    // have stopped after page 12. Every page gets long (non-partial) text.
    const n = 15;
    for (let i = 1; i <= n; i++) tessTexts[i] = LONG_TEXT;
    gsFailsFrom = Infinity;
    execFileMock.mockClear();

    const pages = await ocrTempPdf(buildMultiPagePdf(n));
    expect(pages).toHaveLength(n);
    for (const p of pages) {
      expect(p.text).toBe(LONG_TEXT);
      expect(p.ocrPartial).toBeUndefined();
    }
  });

  it("renders and OCRs each page individually (one gs + one tesseract call per page)", async () => {
    const n = 3;
    for (let i = 1; i <= n; i++) tessTexts[i] = LONG_TEXT;
    gsFailsFrom = Infinity;
    execFileMock.mockClear();

    const pages = await ocrTempPdf(buildMultiPagePdf(n));
    expect(pages).toHaveLength(n);
    // 3 gs renders + 3 tesseract passes = 6 total child_process calls.
    expect(execFileMock).toHaveBeenCalledTimes(6);
    const gsCalls = execFileMock.mock.calls.filter((c) => c[0] === "gs");
    expect(gsCalls).toHaveLength(n);
    for (let i = 1; i <= n; i++) {
      const args = gsCalls[i - 1][1];
      expect(args.find((a) => a.startsWith("-dFirstPage="))).toBe(`-dFirstPage=${i}`);
      expect(args.find((a) => a.startsWith("-dLastPage="))).toBe(`-dLastPage=${i}`);
    }
    const tessCalls = execFileMock.mock.calls.filter((c) => c[0] === "tesseract");
    expect(tessCalls).toHaveLength(n);
  });

  it("marks empty and short pages as ocrPartial, and leaves good pages unflagged", async () => {
    // Page 2 is blank (tesseract found nothing), page 3 is thin (< 50 chars).
    const n = 4;
    tessTexts[1] = LONG_TEXT;
    tessTexts[2] = "";
    tessTexts[3] = "Too short."; // 10 chars < OCR_PARTIAL_CHAR_THRESHOLD
    tessTexts[4] = LONG_TEXT;
    gsFailsFrom = Infinity;

    const pages = await ocrTempPdf(buildMultiPagePdf(n));
    expect(pages).toHaveLength(n);
    expect(pages[0].ocrPartial).toBeUndefined();
    expect(pages[1].text).toBe("");
    expect(pages[1].ocrPartial).toBe(true);
    expect(pages[2].text).toBe("Too short.");
    expect(pages[2].ocrPartial).toBe(true);
    expect(pages[3].ocrPartial).toBeUndefined();
  });

  it("treats exactly-threshold-length text as fully covered", async () => {
    const n = 1;
    tessTexts[1] = "x".repeat(OCR_PARTIAL_CHAR_THRESHOLD); // exactly 50 chars
    gsFailsFrom = Infinity;

    const pages = await ocrTempPdf(buildMultiPagePdf(n));
    expect(pages).toHaveLength(1);
    expect(pages[0].ocrPartial).toBeUndefined();
  });

  it("falls back to per-page probing when pdfjs cannot parse the file", async () => {
    // Garbage bytes: pdfjs fails, so detectPageCount returns null and the loop
    // must terminate on the gs probe. The mocked gs renders pages 1-3 and
    // reports no page 4 → exactly 3 pages are OCR'd.
    for (let i = 1; i <= 3; i++) tessTexts[i] = LONG_TEXT;
    gsFailsFrom = 4;

    const pages = await ocrTempPdf(Buffer.from("this is not a pdf at all"));
    expect(pages).toHaveLength(3);
    for (const p of pages) {
      expect(p.text).toBe(LONG_TEXT);
      expect(p.ocrPartial).toBeUndefined();
    }
  });

  it("returns an empty array when no page can be rendered", async () => {
    gsFailsFrom = 1; // gs fails on the very first page
    const pages = await ocrTempPdf(Buffer.from("this is not a pdf at all"));
    expect(pages).toHaveLength(0);
  });
});


