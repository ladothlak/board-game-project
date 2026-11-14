// OCR fallback for scanned / image-only PDFs (no text layer).
// Pipeline, all via system binaries (no extra npm deps):
//   1. ghostscript (gs) renders each page to a grayscale PNG at 300 DPI.
//   2. tesseract OCRs each PNG (--psm 3, fully automatic layout).
// Returns an array of per-page { text, ocrPartial? } objects: `text` is the
// OCR'd page text (empty string for pages that yield nothing), and
// `ocrPartial` is true when the page's text is empty or very short, so
// downstream consumers know that page's coverage is incomplete. This runs as
// part of the async digest job, so it is fine that it takes tens of seconds
// for a multi-page book.
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const GS = "gs";
const TESSERACT = "tesseract";
const DPI = 300;

/**
 * A page whose OCR text is shorter than this many characters is marked as
 * partially covered: tesseract found little or nothing, so retrieval against
 * that page cannot be trusted. Exported so callers and tests share one number.
 */
export const OCR_PARTIAL_CHAR_THRESHOLD = 50;

/** Run a command, resolving with { code, stdout, stderr } (never throws). */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code ?? 1) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

/**
 * Detect the total page count of a PDF via pdfjs (`doc.numPages`). Returns
 * null when pdfjs cannot parse the file; callers then fall back to probing
 * pages one at a time until gs reports there are no more.
 */
async function detectPageCount(pdfPath) {
  try {
    const buf = await fs.readFile(pdfPath);
    const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
    const n = doc.numPages;
    await doc.destroy();
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * OCR a PDF's pages into text.
 *
 * Processes EVERY page of the document — there is no page cap (issue #74,
 * P1.5). The total page count is detected up front via pdfjs (`doc.numPages`);
 * when pdfjs cannot parse the file, pages are probed one at a time and the
 * loop stops when gs reports there are no more pages.
 *
 * Returns one entry per page: `{ text, ocrPartial? }`. `text` is the OCR'd
 * page text (empty string when tesseract found nothing); `ocrPartial` is
 * present (true) only when the page's text is empty or very short
 * (< OCR_PARTIAL_CHAR_THRESHOLD chars), i.e. that page's coverage is
 * incomplete and downstream consumers should not trust it fully.
 *
 * @param {string} pdfPath - absolute path to the PDF.
 * @returns {Promise<Array<{ text: string; ocrPartial?: boolean }>>} one entry per page.
 */
export async function ocrPdfPages(pdfPath) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "parlor-ocr-"));
  const pages = [];
  try {
    // Detect the total page count up front so every page is OCR'd (no cap).
    // Null when pdfjs cannot parse the file: the per-page gs probe below then
    // terminates the loop.
    const numPages = await detectPageCount(pdfPath);
    for (let i = 1; ; i++) {
      if (numPages !== null && i > numPages) break;
      const png = path.join(tmp, `page-${i}.png`);

      // Render this single page to a PNG. gs prints its banner to stderr;
      // keep it for debugging. A non-zero exit or missing file means there
      // are no more pages (or the render failed) — stop here. This is also
      // the termination condition when pdfjs could not report a page count.
      const gsRes = await run(GS, [
        "-dNOPAUSE", "-dBATCH", "-dSAFER",
        "-sDEVICE=pnggray", `-r${DPI}`,
        `-dFirstPage=${i}`, `-dLastPage=${i}`,
        "-o", png, pdfPath,
      ]);
      let pngExists = false;
      try {
        await fs.access(png);
        pngExists = true;
      } catch {
        /* no rendered page */
      }
      if (gsRes.code !== 0 || !pngExists) {
        console.log(`ocr: stopping after page ${i - 1} (no page ${i})`);
        break;
      }

      // OCR the PNG. tesseract writes to stdout when the output base is
      // "stdout". --psm 3 = fully automatic layout, best for rulebook pages.
      const tessRes = await run(TESSERACT, [png, "stdout", "--psm", "3"]);
      const text = (tessRes.stdout ?? "").replace(/\s+/g, " ").trim();
      // Mark the page as partially covered when tesseract found nothing or
      // very little: an empty page carries no index entries downstream, and a
      // thin one is too sparse to retrieve against reliably.
      const partial = text.length < OCR_PARTIAL_CHAR_THRESHOLD;
      pages.push(partial ? { text, ocrPartial: true } : { text });
      console.log(`ocr: page ${i} -> ${text.length} chars${partial ? " (partial)" : ""}`);

      try {
        await fs.unlink(png); // drop the PNG; we only need the text
      } catch {
        /* file already gone */
      }
    }
    return pages;
  } finally {
    try {
      await fs.rm(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
