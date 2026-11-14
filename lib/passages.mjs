/**
 * Passage chunking (issue #72, P1.3 of RAG-PIPELINE-IMPROVEMENT-PLAN.md).
 *
 * Splits a page's extracted text into 300–600-token passages at paragraph and
 * heading boundaries, with a 10–15% overlap: the last N tokens of passage k
 * are repeated verbatim at the start of passage k+1 (N = ~12% of the passage
 * length). A passage is a contiguous run of the original text, so no word is
 * ever dropped or reordered — words only re-appear across the overlap.
 *
 * Boundary preference: paragraph breaks first, then sentence starts, then
 * word boundaries. The extractor (lib/extract-pdf.mjs) emits paragraph breaks
 * as blank lines (`\n\n`) and headings as their own paragraphs, so paragraph
 * boundaries already include heading positions; the sentence and word
 * fallbacks exist for unstructured text (e.g. OCR output with no line breaks).
 *
 * This is the retrieval unit: scripts/build-index.mjs indexes one entry per
 * passage (carrying parentPage/sectionPath/tokenCount/passageIndex), while
 * citations stay page-based via `parentPage`.
 */

const DEFAULTS = { minTokens: 300, maxTokens: 600, overlapRatio: 0.12 };

/** Words of `text` with their character offsets, in order. */
function tokenize(text) {
  const tokens = [];
  for (const m of text.matchAll(/\S+/g)) {
    tokens.push({ s: m.index, e: m.index + m[0].length });
  }
  return tokens;
}

/** Largest token index whose start offset is ≤ `off` (-1 when before the first). */
function tokenIndexAt(tokens, off) {
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].s <= off) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi;
}

/**
 * Boundary token indices: the positions where a passage may END. Paragraph
 * (and heading) starts are preferred; when the text has no paragraph
 * structure at all (an OCR blob), sentence starts; as a last resort every word
 * boundary. Always includes 0 and tokens.length so the first and last
 * passages are well defined. `maxTokens` sizes the gap-aware fallback: only
 * gaps wider than it get sentence/word cuts added inside them.
 */
function boundaries(text, tokens, maxTokens) {
  const set = new Set([0, tokens.length]);

  // Paragraph/heading starts: the first word of each blank-line-separated block.
  let pos = 0;
  for (const m of text.matchAll(/\n{2,}/g)) {
    const part = text.slice(pos, m.index);
    const off = part.search(/\S/);
    if (off !== -1) set.add(tokenIndexAt(tokens, pos + off));
    pos = m.index + m[0].length;
  }
  const lastPart = text.slice(pos);
  const lastOff = lastPart.search(/\S/);
  if (lastOff !== -1) set.add(tokenIndexAt(tokens, pos + lastOff));

  // Paragraph starts alone can't split a page whose individual paragraphs run
  // longer than maxTokens (common in OCR output): within each oversized gap
  // between consecutive paragraph starts, add sentence starts. Then a second
  // pass adds every word boundary to whatever gaps are still too wide — this
  // catches sentences longer than maxTokens, which sentence cuts alone can't
  // break. The preference order is preserved at every level: a cut is only
  // added where the coarser boundary kind doesn't fit.
  const para = [...set].sort((a, b) => a - b);
  for (let i = 0; i + 1 < para.length; i++) {
    const a = para[i];
    const b = para[i + 1];
    if (b - a <= maxTokens) continue;
    for (const m of text.matchAll(/(?<=[.!?])\s+/g)) {
      const t = tokenIndexAt(tokens, m.index + m[0].length);
      if (t > a && t < b) set.add(t);
    }
  }
  const dense = [...set].sort((a, b) => a - b);
  for (let i = 0; i + 1 < dense.length; i++) {
    const a = dense[i];
    const b = dense[i + 1];
    if (b - a <= maxTokens) continue;
    for (let t = a + 1; t < b; t++) set.add(t);
  }

  return [...set].sort((a, b) => a - b);
}

/** The original text spanned by token range [start, end), trimmed. */
function sliceTokens(text, tokens, start, end) {
  return text.slice(tokens[start].s, tokens[end - 1].e).trim();
}

/**
 * Split `text` into passages of ~300–600 tokens with a ~12% overlap.
 *
 * Returns `{ text, tokenCount }[]` in page order: each `text` is a contiguous
 * slice of the input (whitespace preserved as-is — callers flatten it for
 * storage), and `tokenCount` its approximate word count. A page shorter than
 * `minTokens` yields a single passage; the last passage of a page may be
 * shorter than `minTokens`. A non-final passage can also fall below
 * `minTokens` when a short paragraph is followed by a gap whose next
 * boundary lies beyond `maxTokens` — extending to that boundary would
 * overshoot, so the cut stays at the paragraph end. `minTokens` is a target,
 * not a hard floor; only the `maxTokens` ceiling is guaranteed.
 *
 * @param {string} text Page text (newlines intact: `\n\n` paragraph breaks).
 * @param {{ minTokens?: number, maxTokens?: number, overlapRatio?: number }} [opts]
 *   `overlapRatio` is the fraction of a passage's length repeated at the start
 *   of the next one (default 0.12, inside the plan's 10–15% band).
 */
export function splitPassages(text, opts = {}) {
  const { minTokens = DEFAULTS.minTokens, maxTokens = DEFAULTS.maxTokens, overlapRatio = DEFAULTS.overlapRatio } = opts;
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];

  const b = boundaries(text, tokens, maxTokens);

  const out = [];
  let start = 0;
  while (start < tokens.length) {
    // Farthest boundary within maxTokens of `start`. Cut points land on
    // paragraph/heading/sentence starts — never mid-word.
    let end = null;
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i] > start && b[i] - start <= maxTokens) {
        end = b[i];
        break;
      }
    }
    // No boundary fits (one unit larger than maxTokens): take the next
    // boundary even though it overshoots — a passage must stay contiguous.
    if (end === null) end = b.find((x) => x > start);
    if (end === undefined || end <= start) end = tokens.length;

    const len = end - start;
    out.push({ text: sliceTokens(text, tokens, start, end), tokenCount: len });

    if (end >= tokens.length) break;
    // Overlap: the last ~overlapRatio of this passage leads the next one.
    const overlap = Math.round(overlapRatio * len);
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}
