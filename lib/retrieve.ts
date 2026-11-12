import fs from "fs/promises";
import path from "path";

export interface Chunk {
  id: string;
  slug: string;
  title: string;
  page: number;
  text: string;
  /** True when this chunk belongs to an expansion (not the base game). */
  isExpansion?: boolean;
}

let cache: Chunk[] | null = null;
let cacheMtime = -1;

/**
 * Load the search index written by scripts/build-index.mjs. The digest
 * rewrites this file at runtime (when a game is added), so we re-read it
 * whenever its mtime changes — otherwise a running server would keep serving
 * a stale in-memory copy and new games would have no searchable/chat context.
 */
export async function loadIndex(): Promise<Chunk[]> {
  const p = path.join(process.cwd(), "public", "search-index.json");
  let mtime = -1;
  try {
    mtime = (await fs.stat(p)).mtimeMs;
  } catch {
    /* no index file yet */
  }
  if (cache && mtime === cacheMtime) return cache;
  let entries: Chunk[] = [];
  try {
    const raw = JSON.parse(await fs.readFile(p, "utf8")).entries ?? [];
    // Sanitize each chunk's text to strip running navigation headers.
    // Infer isExpansion from ID for index files written before the field existed.
    entries = raw.map((c: Chunk) => ({
      ...c,
      text: sanitizeChunkText(c.text),
      isExpansion: c.isExpansion ?? c.id.includes("-exp-"),
    }));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Failed to read search index:`, e);
    }
  }
  cache = entries;
  cacheMtime = mtime;
  return cache;
}

export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

/** Document frequency across a chunk set: term → number of chunks containing it. */
export function buildDocFreq(chunks: Chunk[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const c of chunks) {
    const seen = new Set(tokenize(c.text));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return df;
}

/**
 * Per-slug document-frequency tables, rebuilt only when the index changes.
 * `retrieve()` used to recompute this on every call (and multiQueryRetrieve
 * calls it 2–3× per question), so we compute it once per index load and reuse.
 */
let dfCache: { mtime: number; tables: Map<string, Map<string, number>> } | null = null;

export async function docFreqFor(slug: string): Promise<Map<string, number> | undefined> {
  const chunks = await loadIndex();
  if (!dfCache || dfCache.mtime !== cacheMtime) {
    const tables = new Map<string, Map<string, number>>();
    for (const c of chunks) {
      let t = tables.get(c.slug);
      if (!t) {
        t = new Map();
        tables.set(c.slug, t);
      }
      for (const term of new Set(tokenize(c.text))) t.set(term, (t.get(term) ?? 0) + 1);
    }
    dfCache = { mtime: cacheMtime, tables };
  }
  return dfCache.tables.get(slug);
}

/**
 * Strip running navigation headers/sidebar text that PDF extraction picks up
 * from the rulebook's margin. These appear as a sequence of "SECTION Page N"
 * or "SECTION Pages N-M" entries repeated on many pages (e.g. Nemesis has a
 * sidebar listing all sections on every other page). Without cleaning, the
 * page map shows these as "recurring table of contents" content, which misleads
 * the LLM into thinking those pages are TOC pages.
 */
function sanitizeChunkText(text: string): string {
  // Strip a leading standalone page number (e.g. "7 " at the start).
  let cleaned = text.replace(/^\s*\d+\s+/, "");

  // Detect the navigation sidebar: a long leading block where "Page" or
  // "Pages" appears many times (5+ in the first 800 chars). The sidebar is
  // a flat list of section→page references with no actual rule content.
  const head = cleaned.slice(0, 800);
  const pageRefs = head.match(/Pages?\s+\d+/g);
  if (pageRefs && pageRefs.length >= 5) {
    // Find where the sidebar ends: the last "Page(s) N" reference in the head.
    // Everything up to and including that reference is navigation.
    let lastEnd = 0;
    for (const m of head.matchAll(/Pages?\s+\d+(?:-\d+)?/g)) {
      lastEnd = m.index! + m[0].length;
    }
    // Also include any trailing section name that belongs to the last entry.
    const afterNav = cleaned.slice(lastEnd);
    // If what follows starts with more navigation (another "Page N"), extend.
    const extraMatch = afterNav.match(/^[A-Za-z\s&'-]*?(?:Pages?\s+\d+(?:-\d+)?\s*[A-Za-z\s&'-]*?){0,3}/);
    if (extraMatch && extraMatch[0].length > 20) {
      lastEnd += extraMatch[0].length;
    }
    cleaned = cleaned.slice(lastEnd);
  }

  return cleaned.trim();
}

/** Space-separated n-grams of a lowercased string, for phrase matching. */
function ngrams(s: string, n: number): string[] {
  const words = s.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) {
    out.push(words.slice(i, i + n).join(" "));
  }
  return out;
}

/**
 * Fuzzy retrieval over the rulebook chunks. Combines two signals:
 *
 *  - TF-IDF: distinctive query terms (rare across pages) weigh more than
 *    common ones, so a page that really talks about the topic outranks a page
 *    that merely shares a couple of generic words.
 *  - Phrase matching: an exact substring hit on the whole query (or one of
 *    its 3-grams / 2-grams) is strong evidence and gets a big bonus, so a
 *    page that literally contains "round phases" jumps to the top.
 *
 * Returns the top k chunks for the query, with a score.
 */
export function retrieve(chunks: Chunk[], query: string, k = 4, df?: Map<string, number>) {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  // Document frequency → inverse document frequency across all chunks.
  // Reuse a precomputed table when one is provided (see docFreqFor).
  const N = chunks.length;
  const idf = (t: string) => Math.log((N + 1) / ((df?.get(t) ?? 0) + 1)) + 1;

  const qLower = query.trim().toLowerCase();
  // Phrase signals, strongest first. A gram only counts if it carries at
  // least one real word (length > 2) so pure stopword grams don't add noise.
  const phrases: { gram: string; weight: number }[] = [
    { gram: qLower, weight: 6 },
    ...ngrams(qLower, 3)
      .filter((g) => g.split(" ").some((w) => w.length > 2))
      .map((g) => ({ gram: g, weight: 2.5 })),
    ...ngrams(qLower, 2)
      .filter((g) => g.split(" ").some((w) => w.length > 2))
      .map((g) => ({ gram: g, weight: 1.2 })),
  ];

  const scored = chunks
    .map((chunk) => {
      const text = chunk.text.toLowerCase();
      let score = 0;

      // TF-IDF over the query terms.
      const tfCounts = new Map<string, number>();
      for (const t of tokenize(text)) tfCounts.set(t, (tfCounts.get(t) ?? 0) + 1);
      for (const t of qTokens) {
        const tf = tfCounts.get(t) ?? 0;
        if (tf > 0) score += idf(t) * Math.log(1 + tf);
      }

      // Phrase bonuses.
      for (const { gram, weight } of phrases) {
        if (gram.length >= 4 && text.includes(gram)) score += weight;
      }

      // Title match.
      if (chunk.title.toLowerCase().includes(qLower)) score += 2;

      return { chunk, score };
    })
    .filter((r) => r.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((r) => ({ ...r.chunk, score: r.score }));
}

/**
 * A one-line-per-page map of the whole rulebook. It's cheap to include in
 * context every time, so the model always knows what each page covers — even
 * when only a few pages are fully loaded. That gives it effective "access" to
 * the entire book without overflowing the context window.
 */
export function pageMap(chunks: Chunk[]): string[] {
  const byPage = new Map<number, string>();
  for (const c of chunks) {
    if (!byPage.has(c.page)) byPage.set(c.page, c.text);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, text]) => {
      const clean = text.replace(/\s+/g, " ").trim();
      const summary = clean.length > 120 ? clean.slice(0, 117) + "…" : clean;
      return `p. ${page}: ${summary}`;
    });
}

/**
 * Structured per-page table of contents: one short label per page that has
 * extracted text. The PDF viewer merges this with its own page count so every
 * page is listed (labelled where we have text), and tapping one jumps there.
 */
export function pageToc(chunks: Chunk[]): { page: number; label: string }[] {
  const byPage = new Map<number, string>();
  for (const c of chunks) {
    if (!byPage.has(c.page)) byPage.set(c.page, c.text);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, text]) => {
      const clean = text.replace(/\s+/g, " ").trim();
      const label = clean.length > 64 ? clean.slice(0, 61) + "…" : clean;
      return { page, label };
    });
}
