// OCR fallback CLI — run as a child process from the server for scanned /
// image-only PDFs that have no text layer. Renders each page to a PNG with
// pdftoppm, transcribes it with tesseract, and prints the per-page text as
// JSON (the same shape lib/extract-pdf.mjs produces).
import { execFileSync } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

const [pdfPath] = process.argv.slice(2);
if (!pdfPath) {
  process.stderr.write("usage: node lib/ocr-cli.mjs <pdf-path>\n");
  process.exit(1);
}

const DPI = 300; // standard OCR resolution
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "parlor-ocr-"));

function pageNumber(name) {
  const m = name.match(/page-(\d+)\.png$/);
  return m ? parseInt(m[1], 10) : Infinity;
}

try {
  // Render every page to a PNG. Output files are <prefix>-<n>.png.
  execFileSync(
    "pdftoppm",
    ["-png", "-r", String(DPI), pdfPath, path.join(tmpDir, "page")],
    { stdio: "ignore", maxBuffer: 1024 * 1024 }
  );

  const files = (await fs.readdir(tmpDir))
    .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
    .sort((a, b) => pageNumber(a) - pageNumber(b));

  const pages = [];
  for (const f of files) {
    // tesseract <image> stdout  → transcription on stdout.
    const text = execFileSync(
      "tesseract",
      [path.join(tmpDir, f), "stdout"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 10 * 1024 * 1024 }
    ).trim();
    pages.push(text);
  }

  process.stdout.write(JSON.stringify(pages) + "\n");
} catch (e) {
  process.stderr.write(`ocr failed: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
} finally {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}
