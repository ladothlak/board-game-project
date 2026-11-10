// Render the first page of a PDF to a JPEG cover image.
// Spawns lib/render-cover-cli.mjs as a child process (pdfjs can't run in
// the Next.js server bundle). Resolves with the output path on success,
// rejects on failure.
import { execFile } from "child_process";
import path from "path";

/**
 * @param {string} pdfPath
 * @param {string} outPath
 * @returns {Promise<string>}
 */
export function renderCoverFromPdf(pdfPath, outPath) {
  return new Promise((resolve, reject) => {
    const script = path.join(process.cwd(), "lib", "render-cover-cli.mjs");
    execFile(
      process.execPath,
      [script, pdfPath, outPath],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
        } else {
          resolve(outPath);
        }
      }
    );
  });
}
