import fs from "fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Extract per-page text from a PDF. Returns an array of page strings. */
export async function extractPdfPages(pdfPath) {
  const buf = fs.readFileSync(pdfPath);
  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.map((item) => item.str).join(" "));
  }
  return pages;
}
