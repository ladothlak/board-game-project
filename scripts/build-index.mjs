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
// v5: passage chunking (issue #72) — pages are split into 300–600-token
// passages at paragraph/heading boundaries with a ~12% overlap, and the index
// stores one entry per passage (carrying parentPage/passageIndex/tokenCount)
// instead of one per whole page. Passage splitting depends on the extractor's
// paragraph structure (`\n\n` breaks, headings as their own paragraphs), so
// caches written by older extractors — whose text may lack that structure —
// must be re-extracted before they are chunked; the bump forces that.
const EXTRACT_VERSION = 5;
import fs from "fs/promises";
import path from "path";
import { extractPdfPagesWithHeadings } from "../lib/extract-pdf.mjs";
import { ocrPdfPages } from "../lib/ocr-pdf.mjs";
import { assignSectionPaths } from "../lib/sections.mjs";
import { splitPassages } from "../lib/passages.mjs";
import { computeGameHealth, findFailingGames } from "../lib/page-health.mjs";

const root = process.cwd();
const gamesDir = path.join(root, "content", "games");
const outPath = path.join(root, "public", "search-index.json");

let dirEntries = [];
try {
  dirEntries = await fs.readdir(gamesDir, { withFileTypes: true });
} catch {
  console.log("No content/games directory found — nothing to index.");
}

/**
 * Resolve the health-check threshold as a percentage (0–100) from a CLI flag or
 * the EXTRACTION_HEALTH_THRESHOLD env var, defaulting to 80. A value in (0, 1]
 * is treated as a fraction (so "0.8" means 80%) for convenience; anything else
 * is read as a percent. Non-numeric input falls back to the default.
 */
function parseThreshold() {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf("--threshold");
  const raw =
    flagIdx !== -1 && args[flagIdx + 1] ? args[flagIdx + 1] : process.env.EXTRACTION_HEALTH_THRESHOLD;
  if (raw == null) return 80;
  const n = Number(raw);
  if (Number.isNaN(n)) return 80;
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  return Math.min(100, Math.max(0, pct));
}

/** Render the per-game health report: one line per game with its score and a ✓/✗. */
function formatHealthReport(results, thresholdPct) {
  const lines = [`Extraction health (threshold ${thresholdPct}%):`];
  for (const r of results) {
    const pct = (r.health.score * 100).toFixed(1);
    const ok = r.health.totalPages === 0 || r.health.score >= thresholdPct / 100;
    lines.push(
      `  ${r.slug}: ${r.health.totalPages} pages — ` +
        `${r.health.midWord} mid-word, ${r.health.boilerplate} boilerplate, ` +
        `${r.health.noText} no-text, ${r.health.duplicates} dupes → ${pct}% ${ok ? "✓" : "✗"}`
    );
  }
  return lines.join("\n");
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
    // No rulebook to index and no pages to health-check: an empty report so the
    // game is simply skipped by the threshold gate.
    return { slug, title: null, pages: [], health: computeGameHealth([]), entries: [] };
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
      if (extracted === null) {
        // Extraction failed entirely: no pages, so an empty health report and no
        // entries. The threshold gate skips zero-page games, so this does not
        // fail the build — it just indexes nothing for this game.
        return { slug, title: meta.title ?? slug, pages: [], health: computeGameHealth([]), entries: [] };
      }
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

  // Extraction health check (issue #73, P1.4): run AFTER extraction so every game
  // — cached or freshly extracted — is scored on its page text BEFORE any of it
  // is written into the index. A failing game is reported and (below threshold)
  // stops the build before bad data is persisted.
  const health = computeGameHealth(pages.map((p) => p.text));

  // Index PASSAGES, not whole pages (issue #72): each page's text is split into
  // 300–600-token passages at paragraph/heading boundaries with a ~12%
  // overlap. The raw text keeps its newlines so the splitter can find those
  // boundaries; each passage is flattened for storage. Citations stay
  // page-based: `parentPage` (kept equal to `page` for backward compatibility)
  // is what lib/rag.ts derives excerptedPages from. OCR fallback pages flow
  // through the same splitter — its sentence/word boundary fallbacks handle
  // unstructured text.
  const entries = pages.flatMap((p, i) => {
    const raw = (p.text ?? "").trim();
    if (!raw) return [];
    const sectionPath = sectionPaths[i];
    const headings = (p.headings || []).map((h) => h.text);
    return splitPassages(raw)
      .map((passage, s) => {
        const clean = passage.text.replace(/\s+/g, " ").trim();
        if (!clean) return null;
        return {
          id: `${slug}-p${i + 1}-s${s}`,
          slug,
          title: meta.title ?? slug,
          page: i + 1,
          parentPage: i + 1,
          passageIndex: s,
          tokenCount: passage.tokenCount,
          text: clean,
          isExpansion: false,
          sectionPath,
          headings,
        };
      })
      .filter(Boolean);
  });

  return { slug, title: meta.title ?? slug, pages, health, entries };
}

const results = await Promise.all(
  dirEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => buildGame(entry.name, path.join(gamesDir, entry.name)))
);

const entries = results.flatMap((r) => r.entries);

// ─── Extraction health report + threshold gate (issue #73, P1.4) ────────────
// Run after every game is extracted but BEFORE the index is written, so a game
// whose extraction falls below the threshold stops the build and its bad data
// never reaches public/search-index.json. The threshold is configurable via the
// EXTRACTION_HEALTH_THRESHOLD env var or a `--threshold <pct>` CLI flag (percent,
// default 80).
const thresholdPct = parseThreshold();
console.log("");
console.log(formatHealthReport(results, thresholdPct));

const failing = findFailingGames(
  results.map((r) => ({ slug: r.slug, ...r.health })),
  thresholdPct
);
if (failing.length > 0) {
  console.error(
    `✗ Health check failed: ${failing.length} game(s) below the ${thresholdPct}% threshold — index NOT written:`
  );
  for (const r of failing) {
    const pct = (r.score * 100).toFixed(1);
    console.error(
      `  - ${r.slug}: ${pct}% (${r.midWord} mid-word, ${r.boilerplate} boilerplate, ` +
        `${r.noText} no-text, ${r.duplicates} dupes of ${r.totalPages} pages)`
    );
  }
  process.exit(1);
}

await fs.mkdir(path.dirname(outPath), { recursive: true });
// Minified: the index is machine-consumed, and pretty-printing inflates it
// several-fold.
// Schema v3 (issue #72): entries are PASSAGES, not whole pages — each carries
// parentPage/passageIndex/tokenCount alongside the page-level fields kept for
// backward compatibility (`page` === `parentPage`, so existing consumers of
// chunk.page keep working). Consumers that read only `page` + `text` (v1/v2
// shape) are unaffected.
await fs.writeFile(
  outPath,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    schemaVersion: 3,
    analyzerVersion: "p1.3-passage-v1",
    embeddingModel: null,
    entries,
  })
);
console.log(`Wrote ${entries.length} passages to public/search-index.json`);
