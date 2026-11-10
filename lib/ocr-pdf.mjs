// OCR fallback for scanned / image-only PDFs (no text layer).
// Pipeline, all via system binaries (no extra npm deps):
//   1. ghostscript (gs) renders each page to a grayscale PNG at 300 DPI.
//   2. tesseract OCRs each PNG (--psm 3, fully automatic layout).
// Returns an array of per-page text strings (empty string for pages that
// yield nothing). This runs as part of the async digest job, so it is fine
// that it takes tens of seconds for a multi-page book.
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

const GS = "gs";
const TESSERACT = "tesseract";
const DPI = 300;

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
 * OCR a PDF's pages into text.
 * @param {string} pdfPath - absolute path to the PDF.
 * @param {{ maxPages?: number }} [opts]
 * @returns {Promise<string[]>} per-page text (length <= maxPages).
 */
export async function ocrPdfPages(pdfPath, { maxPages = 12 } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "parlor-ocr-"));
  const pages = [];
  try {
    for (let i = 1; i <= maxPages; i++) {
      const png = path.join(tmp, `page-${i}.png`);

      // Render this single page to a PNG. gs prints its banner to stderr;
      // keep it for debugging. A non-zero exit or missing file means there
      // are no more pages (or the render failed) — stop here.
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
      pages.push(text);
      console.log(`ocr: page ${i} -> ${text.length} chars`);

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
