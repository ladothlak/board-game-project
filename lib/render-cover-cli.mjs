// Render the first page of a PDF to a JPEG image using ghostscript.
// Usage: node lib/render-cover-cli.mjs <pdf-path> <output-jpg-path>
//
// Ghostscript is already installed (used for OCR). It reliably renders
// PDF pages to raster images without the pdfjs + node-canvas compatibility
// issues. Prints "ok" on success.
import { execFile } from "child_process";

const [pdfPath, outPath] = process.argv.slice(2);
if (!pdfPath || !outPath) {
  process.stderr.write("usage: node lib/render-cover-cli.mjs <pdf-path> <output-jpg-path>\n");
  process.exit(1);
}

execFile(
  "gs",
  [
    "-dNOPAUSE",
    "-dBATCH",
    "-sDEVICE=jpeg",
    "-r150", // 150 DPI — good quality for a cover thumbnail
    "-dFirstPage=1",
    "-dLastPage=1",
    `-sOutputFile=${outPath}`,
    pdfPath,
  ],
  { timeout: 30_000 },
  (error, stdout, stderr) => {
    if (error) {
      process.stderr.write(`render failed: ${stderr?.trim() || error.message}\n`);
      process.exit(1);
    } else {
      process.stdout.write("ok\n");
    }
  }
);
