import { indexMtime } from "@/lib/retrieve";

/**
 * In-memory final-answer cache (issue #56). Keyed by slug + normalized
 * question (same normalization as the prewarm key), storing the full answer
 * plus its citations. Entries expire after 24 hours and are capped at 100
 * (answers are small — a few hundred KB total). Each entry is stamped with
 * the search index mtime it was built against, so a re-digested rulebook
 * invalidates it: when `loadIndex()` picks up a new file, `indexMtime()`
 * changes and stale entries are dropped on read.
 */
const answerCache = new Map<string, { answer: string; citations: { page: number }[]; ts: number; mtime: number }>();
const ANSWER_TTL = 24 * 60 * 60 * 1000;
const ANSWER_MAX = 100;

// Periodic TTL sweep, like the prewarm cache. `.unref()` so it never keeps a
// short-lived process (e.g. `next start` during tests) alive.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of answerCache) {
    if (now - entry.ts > ANSWER_TTL) answerCache.delete(key);
  }
}, 30_000).unref();

function answerKey(slug: string, question: string): string {
  return `${slug}::${question.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/** Look up a cached final answer, dropping it if expired or stale. */
export function getAnswer(slug: string, question: string) {
  const key = answerKey(slug, question);
  const entry = answerCache.get(key);
  if (!entry) return null;
  // Expired, or built against an older index (a re-digest rewrote the file).
  if (Date.now() - entry.ts > ANSWER_TTL || entry.mtime !== indexMtime()) {
    answerCache.delete(key);
    return null;
  }
  return entry;
}

/**
 * Store a successful final answer. Evicts the oldest entry when over cap, and
 * stamps the current index mtime so a re-digest invalidates it.
 */
export function storeAnswer(slug: string, question: string, answer: string, citations: { page: number }[]): void {
  const key = answerKey(slug, question);
  if (answerCache.size >= ANSWER_MAX) {
    const oldest = Array.from(answerCache.entries()).sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) answerCache.delete(oldest[0]);
  }
  answerCache.set(key, { answer, citations, ts: Date.now(), mtime: indexMtime() });
}

/** Test-only hook: clear the module-level cache between tests. */
export function resetAnswerCacheForTest(): void {
  answerCache.clear();
}
