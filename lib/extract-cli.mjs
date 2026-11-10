// Standalone extraction CLI — run as a child process from the server so
// pdfjs never has to run inside the Next.js bundle (its worker setup
// cannot resolve modules there). Prints ONLY the per-page text as JSON on
// stdout; pdfjs's internal warnings are suppressed so the output stays
// parseable.
import { extractPdfPages } from "./extract-pdf.mjs";

const [pdfPath] = process.argv.slice(2);
if (!pdfPath) {
  process.stderr.write("usage: node lib/extract-cli.mjs <pdf-path>\n");
  process.exit(1);
}

// Silence pdfjs's console noise (it writes to stdout, which would corrupt
// the JSON we emit).
const realLog = console.log;
const realWarn = console.warn;
console.log = () => {};
console.warn = () => {};

try {
  const pages = await extractPdfPages(pdfPath);
  process.stdout.write(JSON.stringify(pages) + "\n");
} catch (e) {
  process.stderr.write(`extraction failed: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
} finally {
  console.log = realLog;
  console.warn = realWarn;
}
