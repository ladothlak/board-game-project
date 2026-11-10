// Builds the search index from all game rulebooks and copies
// cover images + PDFs into public/ so they can be served.
import fs from "fs";
import path from "path";
import { extractPdfPages } from "../lib/extract-pdf.mjs";
import { ocrPdfPages } from "../lib/ocr-pdf.mjs";

const root = process.cwd();
const gamesDir = path.join(root, "content", "games");
const outPath = path.join(root, "public", "search-index.json");

const entries = [];

if (!fs.existsSync(gamesDir)) {
  console.log("No content/games directory found — nothing to index.");
} else {
  for (const entry of fs.readdirSync(gamesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const dir = path.join(gamesDir, slug);
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) continue;

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch (e) {
      console.error(`✗ ${slug}: bad meta.json — ${e.message}`);
      continue;
    }

    // Extract per-page text from the rulebook PDF. (Assets are served on
    // demand from content/ via /api/games/[slug]/file, so no copy to
    // public/ is needed.) If the PDF has no text layer (scanned), fall back
    // to OCR so its rules are still searchable.
    const pdfName = meta.pdf ?? "rules.pdf";
    const pdfPath = path.join(dir, pdfName);
    let pages = [];
    if (fs.existsSync(pdfPath)) {
      try {
        pages = await extractPdfPages(pdfPath);
        if (pages.join("").length < 200) {
          console.log(`⚠ ${slug}: no text layer in ${pdfName} — falling back to OCR`);
          try {
            pages = await ocrPdfPages(pdfPath, { maxPages: 12 });
          } catch (e) {
            console.error(`✗ ${slug}: OCR failed — ${e.message}`);
            pages = [];
          }
        }
      } catch (e) {
        console.error(`✗ ${slug}: failed to parse ${pdfName} — ${e.message}`);
      }
    } else {
      console.warn(`⚠ ${slug}: no ${pdfName} found — no rulebook text will be indexed for this game.`);
    }

    pages.forEach((text, i) => {
      const clean = (text ?? "").replace(/\s+/g, " ").trim();
      if (clean) {
        entries.push({
          id: `${slug}-p${i + 1}`,
          slug,
          title: meta.title ?? slug,
          page: i + 1,
          text: clean,
        });
      }
    });
    console.log(`✓ ${slug}: ${pages.length} pages indexed`);
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2)
);
console.log(`Wrote ${entries.length} chunks to public/search-index.json`);
