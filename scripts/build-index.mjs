// Builds the search index from all game rulebooks.
// Extraction is incremental: each game caches its extracted page text in a
// sidecar file (content/games/<slug>/.index-cache.json) keyed by PDF size +
// mtime, so unchanged rulebooks are skipped and only changed ones are
// re-extracted. Games are processed in parallel.
//
// The cache is also versioned: extractVersion bumps whenever the extractor
// changes its output format (issue #70 for layout-aware extraction, issue #71
// for heading/section index), so stale caches from older extractors are
// re-extracted even when the PDF itself is unchanged.
// v4: bold-heading tightening (review of #71) — fewer flagged headings, so
// stale v3 caches must be re-extracted.
const EXTRACT_VERSION = 4;
import fs from "fs/promises";
import path from "path";
import { extractPdfPagesWithHeadings } from "../lib/extract-pdf.mjs";
import { ocrPdfPages } from "../lib/ocr-pdf.mjs";
import { assignSectionPaths } from "../lib/sections.mjs";

const root = process.cwd();
const gamesDir = path.join(root, "content", "games");
const outPath = path.join(root, "public", "search-index.json");

let dirEntries = [];
try {
  dirEntries = await fs.readdir(gamesDir, { withFileTypes: true });
} catch {
  console.log("No content/games directory found — nothing to index.");
}

/** Identity of a PDF: size + mtime is cheap enough to skip full hashing. */
async function pdfIdentity(pdfPath) {
  const stat = await fs.stat(pdfPath);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * Extract page text AND heading info from a PDF (OCR fallback for scanned
 * files). Returns an array of `{ text: string; headings: HeadingInfo[] }`
 * per page, or null on failure.
 */
async function extractPagesWithHeadings(slug, pdfName, pdfPath) {
  try {
    let pages = await extractPdfPagesWithHeadings(pdfPath);
    if (pages.map((p) => p.text).join("").length < 200) {
      console.log(`⚠ ${slug}: no text layer in ${pdfName} — falling back to OCR`);
      try {
        const ocrPages = await ocrPdfPages(pdfPath, { maxPages: 12 });
        pages = ocrPages.map((text) => ({ text, headings: [] }));
      } catch (e) {
        console.error(`✗ ${slug}: OCR failed — ${e.message}`);
        return null;
      }
    }
    return pages;
  } catch (e) {
    console.error(`✗ ${slug}: failed to parse ${pdfName} — ${e.message}`);
    return null;
  }
}

async function buildGame(slug, dir) {
  const metaPath = path.join(dir, "meta.json");
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch (e) {
    console.error(`✗ ${slug}: bad meta.json — ${e.message}`);
    return [];
  }

  const pdfName = meta.pdf ?? "rules.pdf";
  const pdfPath = path.join(dir, pdfName);
  let pdfExists = false;
  try {
    await fs.access(pdfPath);
    pdfExists = true;
  } catch {
    /* no rulebook PDF */
  }

  let pages = [];
  if (pdfExists) {
    // Incremental: reuse the cached extraction when the PDF is unchanged.
    const cachePath = path.join(dir, ".index-cache.json");
    const identity = await pdfIdentity(pdfPath);
    let cached = null;
    try {
      cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    } catch {
      /* no cache yet */
    }
    const fresh =
      cached &&
      cached.pdfName === pdfName &&
      Array.isArray(cached.pages) &&
      cached.extractVersion === EXTRACT_VERSION &&
      cached.size === identity.size &&
      cached.mtimeMs === identity.mtimeMs;

    if (fresh) {
      pages = cached.pages;
      console.log(`✓ ${slug}: ${pages.length} pages (cached)`);
    } else {
      const extracted = await extractPagesWithHeadings(slug, pdfName, pdfPath);
      if (extracted === null) return [];
      pages = extracted;
      // Atomic write so a crash mid-build can't leave a corrupt cache.
      const tmpPath = `${cachePath}.tmp`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({ pdfName, extractVersion: EXTRACT_VERSION, ...identity, pages })
      );
      await fs.rename(tmpPath, cachePath);
      console.log(`✓ ${slug}: ${pages.length} pages indexed`);
    }
  } else {
    console.warn(
      `⚠ ${slug}: no ${pdfName} found — no rulebook text will be indexed for this game.`
    );
  }

  // Assign section paths from structural headings (with regex fallback).
  const sectionPaths = assignSectionPaths(pages);

  return pages
    .map((p, i) => {
      const clean = (p.text ?? "").replace(/\s+/g, " ").trim();
      if (!clean) return null;
      return {
        id: `${slug}-p${i + 1}`,
        slug,
        title: meta.title ?? slug,
        page: i + 1,
        text: clean,
        isExpansion: false,
        sectionPath: sectionPaths[i],
        headings: (p.headings || []).map((h) => h.text),
      };
    })
    .filter(Boolean);
}

const results = await Promise.all(
  dirEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => buildGame(entry.name, path.join(gamesDir, entry.name)))
);

const entries = results.flat();

await fs.mkdir(path.dirname(outPath), { recursive: true });
// Minified: the index is machine-consumed, and pretty-printing inflates it
// several-fold.
await fs.writeFile(
  outPath,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    schemaVersion: 2,
    analyzerVersion: "p1.2-heading-v1",
    embeddingModel: null,
    entries,
  })
);
console.log(`Wrote ${entries.length} chunks to public/search-index.json`);
