// Builds search-index passage entries from extracted pages (issue #74, P1.5).
// Extracted from scripts/build-index.mjs so the entry schema — in particular
// the `ocrPartial` flag that marks OCR'd pages with incomplete coverage — is
// unit-testable without running a full build.
import { splitPassages } from "./passages.mjs";

/**
 * Build one index entry per non-empty passage of each page (issue #72 shape:
 * passages, not whole pages). Each entry carries parentPage/passageIndex/
 * tokenCount alongside the page-level fields kept for backward compatibility
 * (`page` === `parentPage`).
 *
 * Pages whose OCR coverage is incomplete carry `ocrPartial: true` on every
 * entry derived from them (issue #74): tesseract found nothing or very little
 * (< 50 chars) on that page, so downstream consumers know the coverage is
 * partial. Text-layer pages and fully covered OCR pages omit the field.
 *
 * @param {string} slug - the game's slug.
 * @param {string} title - the game's display title.
 * @param {Array<{ text: string; headings?: Array<{ text: string }>; ocrPartial?: boolean }>} pages
 *   Per-page extracted text (headings from the layout extractor; ocrPartial
 *   set by lib/ocr-pdf.mjs for partially covered OCR pages).
 * @param {string[]} sectionPaths - per-page section path (from assignSectionPaths).
 * @returns {Array<{ id: string; slug: string; title: string; page: number; parentPage: number; passageIndex: number; tokenCount: number; text: string; isExpansion: boolean; sectionPath: string; headings: string[]; ocrPartial?: boolean }>}
 *   index entries, one per non-empty passage.
 */
export function buildPassageEntries(slug, title, pages, sectionPaths) {
  return pages.flatMap((p, i) => {
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
          title,
          page: i + 1,
          parentPage: i + 1,
          passageIndex: s,
          tokenCount: passage.tokenCount,
          text: clean,
          isExpansion: false,
          sectionPath,
          headings,
          // Present only when true (undefined keys are dropped by JSON
          // serialization), so the index stays small and v3-shaped.
          ocrPartial: p.ocrPartial === true ? true : undefined,
        };
      })
      .filter(Boolean);
  });
}
