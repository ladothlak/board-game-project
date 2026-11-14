// Per-page extraction health checks (issue #73, P1.4).
//
// These are pure, CI-safe functions over a game's extracted page texts. They
// flag the four corruption modes that silently poison the search index:
//   1. starts mid-word   — the page's first character is lowercase, so the text
//                          begins inside a sentence (a column wrap that dropped
//                          the start of the line).
//   2. boilerplate-start — the page opens with print-shop furniture: a bare page
//                          number, "Printed by …", a running head ("flat sheet"),
//                          or an InDesign job name (.indd/.qxd).
//   3. no text           — the page is empty or has fewer than 20 trimmed chars,
//                          so there is nothing to retrieve against.
//   4. duplicate page    — the page is identical (or >95% similar) to another
//                          page in the same game, i.e. a repeated spread/insert.
//
// The per-page predicates are reused verbatim from scripts/measure-extraction.mjs
// so the health report stays consistent with the corpus measurements. NOTE: the
// mid-word check is an UPPER BOUND on true corruption — legitimate lowercase
// section headings (e.g. "setup", "gameplay") also match, so a page flagged as
// mid-word may not actually be corrupted. That is why the build gates on a
// *score* (fraction of clean pages) rather than demanding zero flags.

/** Normalize text for duplicate comparison: trim, collapse whitespace, lowercase. */
function normalizeForCompare(text) {
  return (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * True when a page starts mid-word: its first non-whitespace character is
 * lowercase, so the text begins inside a sentence. Reused from
 * scripts/measure-extraction.mjs; an upper bound on true corruption (legitimate
 * lowercase headings also match).
 */
export function startsWithMidWord(pageText) {
  const t = (pageText ?? "").trim();
  if (!t) return false;
  return /^[a-z]/.test(t);
}

/**
 * True when a page opens with print-shop furniture: a bare page number,
 * "Printed by …", a running head ("flat sheet"), or an InDesign job name
 * (.indd). Reused verbatim from scripts/measure-extraction.mjs. An empty first
 * line counts as boilerplate (the page has no real leading content).
 */
export function startsWithBoilerplate(pageText) {
  const firstLine = ((pageText ?? "").split(/\n+/)[0] ?? "").trim();
  if (!firstLine) return true; // empty page: no real leading content.
  return (
    /^\d+$/.test(firstLine) ||
    /^printed by/i.test(firstLine) ||
    /flat sheet/i.test(firstLine) ||
    /\.indd\b/i.test(firstLine)
  );
}

/** True when a page has no retrievable text: empty, or < 20 trimmed chars. */
export function hasNoText(pageText) {
  return (pageText ?? "").trim().length < 20;
}

/** Character-bigram set of a string (for the Dice similarity below). */
function charBigrams(s) {
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * Sørensen–Dice coefficient over character bigrams, in [0, 1]. Identical strings
 * score 1.0. A cheap O(n) near-duplicate metric: two pages that differ by only a
 * little text share almost all their bigrams, so the ratio stays high.
 */
function diceSimilarity(a, b) {
  if (a === b) return 1;
  const ba = charBigrams(a);
  const bb = charBigrams(b);
  if (ba.size === 0 || bb.size === 0) return a === b ? 1 : 0;
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  return (2 * inter) / (ba.size + bb.size);
}

/**
 * True when page `index` is a duplicate of some OTHER page in `pageTexts`:
 * identical after normalization, or >95% similar. A page shorter than the
 * no-text threshold is never treated as a duplicate (there is nothing to
 * compare), so blank pages are only flagged by hasNoText, not doubled up here.
 */
export function isDuplicatePage(pageTexts, index) {
  const ti = normalizeForCompare(pageTexts[index]);
  if (ti.length < 20) return false;
  for (let j = 0; j < pageTexts.length; j++) {
    if (j === index) continue;
    const tj = normalizeForCompare(pageTexts[j]);
    if (!tj.length) continue;
    // A >95%-similar pair must have nearly equal lengths: an edit can change the
    // length by at most the number of characters it touches, so a gap larger than
    // 5% rules out similarity and lets us skip the (more expensive) Dice check.
    const maxLen = Math.max(ti.length, tj.length);
    if (Math.abs(ti.length - tj.length) / maxLen > 0.05) continue;
    if (ti === tj) return true;
    if (diceSimilarity(ti, tj) > 0.95) return true;
  }
  return false;
}

/**
 * Aggregate the per-page checks into a per-game health report.
 *
 * A page PASSES when it fails NONE of the four checks; the score is the fraction
 * of pages that pass (1 = every page clean, 0 = every page flagged). A game with
 * no pages scores 1 (there is nothing to check), so a rulebook-less game never
 * fails the threshold.
 *
 * Returns: { totalPages, midWord, boilerplate, noText, duplicates, passing, score }
 * where midWord/boilerplate/noText/duplicates are per-check failure COUNTS (a page
 * can be counted in more than one), and `passing` is the number of pages that fail
 * none of them.
 */
export function computeGameHealth(pageTexts) {
  const total = pageTexts.length;
  let midWord = 0;
  let boilerplate = 0;
  let noText = 0;
  let duplicates = 0;
  const failing = new Set(); // indices that fail at least one check
  for (let i = 0; i < total; i++) {
    const t = pageTexts[i];
    if (startsWithMidWord(t)) {
      midWord++;
      failing.add(i);
    }
    if (startsWithBoilerplate(t)) {
      boilerplate++;
      failing.add(i);
    }
    if (hasNoText(t)) {
      noText++;
      failing.add(i);
    }
  }
  for (let i = 0; i < total; i++) {
    if (isDuplicatePage(pageTexts, i)) {
      duplicates++;
      failing.add(i);
    }
  }
  const passing = total - failing.size;
  const score = total > 0 ? passing / total : 1;
  return { totalPages: total, midWord, boilerplate, noText, duplicates, passing, score };
}

/**
 * The threshold gate: return the games whose health score is below `thresholdPct`
 * (a percentage, 0–100). Each entry of `reports` must carry at least `slug`,
 * `totalPages`, and `score`. Zero-page games are skipped — a rulebook-less game has
 * nothing to check and must not fail the build. scripts/build-index.mjs exits
 * non-zero when this list is non-empty, so bad data never reaches the index.
 */
export function findFailingGames(reports, thresholdPct) {
  return reports.filter((r) => r.totalPages > 0 && r.score < thresholdPct / 100);
}
