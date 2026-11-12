import { getGame } from "./games";
import { loadIndex, retrieve, pageMap, docFreqFor, tokenize, Chunk } from "./retrieve";

// Unsloth runs locally (Unsloth Studio / `unsloth run`) and exposes an
// OpenAI-compatible API, typically on http://localhost:8888.
const BASE_URL = process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";
const MODEL =
  process.env.UNSLOTH_MODEL ?? "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";

// ─── Types ────────────────────────────────────────────────────────────────

export type QueryType =
  | "setup"
  | "turn-structure"
  | "specific-rule"
  | "edge-case"
  | "comparison"
  | "general";

interface ScoredChunk extends Chunk {
  score: number;
}

export interface RagContext {
  /** The assembled context blocks (page-labelled excerpts). */
  excerpts: string;
  /** The hierarchical TOC for orientation. */
  toc: string;
  /** Confidence 0–1: how well the retrieval matched the question. */
  confidence: number;
  /** Pages cited in the excerpts. */
  pages: number[];
}

// ─── LLM Helper ───────────────────────────────────────────────────────────

async function callLlm(
  apiKey: string,
  system: string,
  user: string,
  maxTokens = 500,
  timeoutMs = 30_000
): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Provider error ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

// ─── 1. Query-Type Classification ─────────────────────────────────────────

const TYPE_KEYWORDS: Record<QueryType, string[]> = {
  setup: ["set up", "setup", "prepare", "begin", "start", "place", "deal", "assemble", "arrange"],
  "turn-structure": ["turn", "round", "phase", "order", "sequence", "step", "who goes first"],
  "specific-rule": ["how do i", "what happens", "can i", "must i", "do i", "rule"],
  "edge-case": ["if", "when", "exception", "instead", "otherwise", "special", "unique", "only"],
  comparison: ["compare", "difference", "versus", "vs", "which is"],
  general: [],
};

/** Classify the question type using keyword heuristics (no LLM call needed). */
export function classifyQuery(question: string): QueryType {
  const q = question.toLowerCase();
  for (const type of ["setup", "turn-structure", "edge-case", "comparison", "specific-rule"] as QueryType[]) {
    if (TYPE_KEYWORDS[type].some((kw) => q.includes(kw))) return type;
  }
  return "general";
}

// ─── 2. Query Expansion ────────────────────────────────────────────────────

/**
 * Ask the LLM to rewrite the question into 2–3 short search variants that
 * use different wording but the same meaning. Falls back to [question] on
 * any failure.
 */
export async function expandQuery(
  apiKey: string,
  question: string,
  queryType: QueryType
): Promise<string[]> {
  try {
    const typeHint =
      queryType === "setup"
        ? "Focus on physical setup and placement wording."
        : queryType === "edge-case"
          ? "Focus on conditional/exception wording (if, when, unless)."
          : queryType === "turn-structure"
            ? "Focus on phase/round/order wording."
            : "Use natural rulebook terminology.";
    // The local model is a reasoning model: it burns several hundred tokens on
    // thinking before answering, so the cap must cover reasoning + answer.
    const raw = await callLlm(
      apiKey,
      "You rewrite a board game question into 2-3 short search phrases (2-5 words each) that would match rulebook text. Return ONLY a JSON array of strings.",
      `Question: "${question}"\n${typeHint}\nReturn a JSON array of 2-3 search phrases.`,
      1000,
      30_000
    );
    // Parse the JSON array.
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) return [question];
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return [question];
    const phrases = arr.map((s) => String(s).trim()).filter(Boolean);
    return phrases.length > 0 ? phrases : [question];
  } catch {
    return [question];
  }
}

// ─── 3. Multi-Query Retrieval ──────────────────────────────────────────────

/**
 * Retrieve using multiple query variants and merge the results. Each variant
 * gets its own top-k; chunks that appear in multiple results get a bonus.
 */
export function multiQueryRetrieve(
  chunks: Chunk[],
  queries: string[],
  k = 6,
  df?: Map<string, number>
): ScoredChunk[] {
  const merged = new Map<string, ScoredChunk>();

  for (const q of queries) {
    const results = retrieve(chunks, q, k, df);
    for (const r of results) {
      const existing = merged.get(r.id);
      if (existing) {
        // Appears in multiple query results → boost.
        existing.score += r.score * 0.5;
      } else {
        merged.set(r.id, { ...r });
      }
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score);
}

// ─── 4. Re-ranking with LLM ────────────────────────────────────────────────

/**
 * Pass top candidates to the LLM for a relevance score (1-5). Returns chunks
 * sorted by LLM score. Falls back to TF-IDF order on failure.
 *
 * Each candidate is previewed with its most query-relevant sentences (not
 * just the first 200 chars), so a relevant passage that sits deep in a long
 * page is visible to the LLM and can be rated accurately.
 */
export async function rerank(
  apiKey: string,
  question: string,
  candidates: ScoredChunk[],
  queryTerms?: Set<string>,
  df?: Map<string, number>,
  n = 0
): Promise<ScoredChunk[]> {
  if (candidates.length === 0) return [];

  const numbered = candidates
    .map((c, i) => {
      const preview =
        queryTerms && queryTerms.size > 0
          ? extractRelevantSentences(c.text, queryTerms, df, 400, n)
          : c.text.slice(0, 200);
      return `[${i}] (p. ${c.page}) ${preview}`;
    })
    .join("\n");

  try {
    // The local model is a reasoning model: it burns several hundred tokens on
    // thinking before answering, so the cap must cover reasoning + answer.
    const raw = await callLlm(
      apiKey,
      "Rate each numbered excerpt's relevance to the question on a scale of 1-5. Return ONLY a JSON array of integers (one per excerpt, in order).",
      `Question: "${question}"\n\nExcerpts:\n${numbered}`,
      1000,
      30_000
    );
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) return candidates;
    const scores: number[] = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(scores) || scores.length !== candidates.length) return candidates;

    // Combine LLM score (weight 3) with TF-IDF score (weight 1).
    const combined = candidates.map((c, i) => ({
      ...c,
      score: c.score * 1 + (scores[i] ?? 3) * 3,
    }));
    return combined.sort((a, b) => b.score - a.score);
  } catch {
    return candidates;
  }
}

// ─── 5. Cross-Reference Following ──────────────────────────────────────────

/**
 * Scan retrieved chunks for page references ("see page N", "p. N", "page N")
 * and pull those pages' text into the result set. Capped at `maxExtra` pages:
 * a single reference-heavy page (e.g. a room sheet) can point at a dozen
 * others, and following all of them dilutes the context budget with noise.
 */
export function followCrossRefs(
  chunks: Chunk[],
  selected: ScoredChunk[],
  maxExtra = 4
): ScoredChunk[] {
  const selectedPages = new Set(selected.map((c) => c.page));
  const extra: ScoredChunk[] = [];

  for (const c of selected) {
    if (extra.length >= maxExtra) break;
    // Find references to other pages in this chunk's text.
    const refs = [...c.text.matchAll(/(?:see|as described in|refer to|on)?\s*page\s+(\d+)/gi)];
    for (const m of refs) {
      if (extra.length >= maxExtra) break;
      const p = Number(m[1]);
      if (p > 0 && !selectedPages.has(p)) {
        const target = chunks.find((ch) => ch.page === p);
        if (target) {
          extra.push({ ...target, score: c.score * 0.3 }); // lower confidence than direct match
          selectedPages.add(p);
        }
      }
    }
  }

  return [...selected, ...extra];
}

// ─── 6. Adaptive Context Budget ────────────────────────────────────────────

/**
 * Split text into sentences and keep the ones most relevant to the query
 * terms, in original order, fitting within `cap` chars. A sentence's relevance
 * is the sum of log((N+1)/(df+1)) over the distinct query terms it contains —
 * the same IDF weighting retrieve() uses, so rarer (more distinctive) terms
 * carry more signal than common ones. Falls back to a prefix slice when no
 * sentence scores, so this never returns less text than a plain cut would.
 */
function extractRelevantSentences(
  text: string,
  terms: Set<string>,
  df: Map<string, number> | undefined,
  cap: number,
  n = 0
): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const scored = sentences.map((s, i) => {
    const lower = s.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (lower.includes(t)) score += Math.log((n + 1) / ((df?.get(t) ?? 0) + 1));
    }
    return { i, s, score };
  });
  const picked = scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .reduce<{ i: number; s: string }[]>(
      (acc, x) =>
        acc.reduce((l, y) => l + y.s.length, 0) + (acc.length > 0 ? 1 : 0) + x.s.length <= cap
          ? [...acc, x]
          : acc,
      []
    );
  if (picked.length === 0) return text.slice(0, cap);
  return picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(" ");
}

/**
 * Allocate a token budget across selected chunks proportionally to their
 * relevance scores. High-relevance chunks get more text; low-relevance get
 * truncated. Total budget is ~4000 chars (roughly 1000 tokens) — big enough
 * that a multi-sentence answer in the top chunk survives its allocation.
 *
 * Every chunk is capped at its allocation — the top chunk included — so one
 * long page can't consume the whole budget. When a chunk must be cut, the most
 * query-relevant sentences are kept (see extractRelevantSentences), so an
 * answer that sits deep in a long page survives instead of being sliced off
 * from the top.
 */
export function adaptiveContext(
  selected: ScoredChunk[],
  budget = 4000,
  queryTerms?: Set<string>,
  df?: Map<string, number>,
  n = 0
): string {
  if (selected.length === 0) return "";

  const totalScore = selected.reduce((s, c) => s + c.score, 0);
  let used = 0;
  const parts: string[] = [];

  for (const c of selected) {
    // Proportional allocation, minimum 200 chars so every chunk is represented.
    const alloc = Math.max(200, Math.round((c.score / totalScore) * budget));
    const remaining = budget - used;
    const cap = Math.min(alloc, Math.max(100, remaining));
    let text: string;
    if (c.text.length <= cap) {
      text = c.text;
    } else if (queryTerms && queryTerms.size > 0) {
      text = extractRelevantSentences(c.text, queryTerms, df, cap, n);
    } else {
      text = c.text.slice(0, cap);
    }
    parts.push(`--- Page ${c.page} ---\n${text}`);
    used += text.length;
    if (used >= budget) break;
  }

  return parts.join("\n\n");
}

// ─── 7. Citation Confidence ────────────────────────────────────────────────

/**
 * Estimate retrieval confidence (0-1) based on how well the top chunks score
 * relative to the maximum possible. Used to decide whether to answer or say
 * "this isn't covered in the rulebook."
 */
export function estimateConfidence(selected: ScoredChunk[]): number {
  if (selected.length === 0) return 0;
  const top = selected[0].score;
  // Normalize: a score of 10+ is very confident, 3+ is moderate, <2 is weak.
  return Math.min(1, top / 10);
}

// ─── 8. Hierarchical TOC ───────────────────────────────────────────────────

/**
 * Build a structured outline from the page map: group pages into sections
 * based on content keywords. This gives the model a document structure
 * beyond a flat one-line-per-page list.
 */
export function hierarchicalToc(chunks: Chunk[]): string {
  const byPage = new Map<number, string>();
  for (const c of chunks) {
    if (!byPage.has(c.page)) byPage.set(c.page, c.text);
  }

  // Simple section detection: look for common rulebook section headers.
  const sectionPatterns: { name: string; pattern: RegExp }[] = [
    { name: "Introduction / Overview", pattern: /\b(introduction|overview|welcome|about)\b/i },
    { name: "Setup", pattern: /\b(setup|set up|prepare|beginning|start)\b/i },
    { name: "Game Structure / Turn Order", pattern: /\b(turn|round|phase|order|structure)\b/i },
    { name: "Core Rules", pattern: /\b(rule|action|play|move|turn)\b/i },
    { name: "Combat / Conflict", pattern: /\b(combat|attack|assault|fight|battle)\b/i },
    { name: "Special Abilities / Keywords", pattern: /\b(ability|keyword|special|unique|trait)\b/i },
    { name: "Victory / End of Game", pattern: /\b(victory|win|end|defeat|lose|score)\b/i },
    { name: "Reference / Quick Play", pattern: /\b(reference|quick|cheat|summary|card)\b/i },
  ];

  const sections = new Map<string, number[]>();
  for (const [page, text] of byPage) {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 200);
    let matched = false;
    for (const { name, pattern } of sectionPatterns) {
      if (pattern.test(clean)) {
        if (!sections.has(name)) sections.set(name, []);
        sections.get(name)!.push(page);
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (!sections.has("Other")) sections.set("Other", []);
      sections.get("Other")!.push(page);
    }
  }

  const lines: string[] = [];
  for (const [name, pages] of sections) {
    lines.push(`${name}: p. ${pages.join(", p. ")}`);
  }
  return lines.join("\n");
}

// ─── 9. Follow-Up Detection ────────────────────────────────────────────────

// ─── 10. Explicit Page Detection ──────────────────────────────────────────

/**
 * Detect explicit page references in the question (e.g. "page 14", "p. 30",
 * "on page 5"). Returns an array of page numbers the user is asking about.
 */
export function detectExplicitPages(question: string): number[] {
  const pages: number[] = [];
  // Match patterns like "page 14", "p. 30", "page 5", "pages 8-11"
  const patterns = [
    /\bpage\s+(\d+)/gi,
    /\bp\.?\s*(\d+)\b/gi,
    /\bon\s+page\s+(\d+)/gi,
  ];
  for (const pattern of patterns) {
    for (const m of question.matchAll(pattern)) {
      const p = Number(m[1]);
      if (p > 0 && !pages.includes(p)) pages.push(p);
    }
  }
  return pages;
}

// ─── Main Pipeline ─────────────────────────────────────────────────────────

/**
 * The full enhanced RAG pipeline:
 * 1. Classify query type
 * 2. Detect explicit page references
 * 3. Expand query into variants
 * 4. Multi-query retrieval
 * 5. Boost explicitly-referenced pages
 * 6. Re-rank with LLM
 * 7. Follow cross-references
 * 8. Adaptive context budget
 * 9. Confidence estimate
 * 10. Hierarchical TOC
 *
 * Returns a RagContext ready to inject into the chat prompt.
 */
export async function buildRagContext(
  slug: string,
  question: string,
  apiKey: string,
  expansionNames?: string[]
): Promise<RagContext> {
  // 1. Classify.
  const queryType = classifyQuery(question);

  // 2. Detect explicit page references (e.g. "Tell me about page 14").
  const explicitPages = detectExplicitPages(question);

  // 3. Expand query — skip the LLM call for short or page-specific queries
  // where TF-IDF retrieval already works well on its own. The expansion LLM
  // call doesn't need the index, so it runs in parallel with loadIndex().
  const needsExpansion = question.length > 20 && explicitPages.length === 0;
  const expandPromise = needsExpansion
    ? expandQuery(apiKey, question, queryType)
    : Promise.resolve([question]);

  const chunks = (await loadIndex()).filter((c) => c.slug === slug);
  if (chunks.length === 0) {
    return { excerpts: "", toc: "", confidence: 0, pages: [] };
  }

  // Precomputed per-slug DF table — avoids re-tokenizing every chunk on each
  // of the 2–3 retrieve() calls below.
  const df = await docFreqFor(slug);

  const queries = await expandPromise;

  // Query terms (tokenized variants) — reused by the re-rank preview and the
  // adaptive context budget so both judge relevance the same way.
  const queryTerms = new Set(queries.flatMap((q) => tokenize(q)));

  // 4. Multi-query retrieval (top 8 for re-ranking).
  let candidates = multiQueryRetrieve(chunks, queries, 8, df);

  // 5. Boost explicitly-referenced pages to the top of the candidate list.
  if (explicitPages.length > 0) {
    for (const p of explicitPages) {
      const pageChunk = chunks.find((c) => c.page === p);
      if (pageChunk) {
        // Give it a very high score so it's always in the top results.
        const boosted: ScoredChunk = { ...pageChunk, score: 100 };
        // Remove any existing entry for this page, then prepend.
        candidates = candidates.filter((c) => c.page !== p);
        candidates.unshift(boosted);
      }
    }
  }

  // 5b. Boost expansion chunks when the query mentions an expansion name.
  if (expansionNames && expansionNames.length > 0) {
    const qLower = question.toLowerCase();
    const mentionedExps = expansionNames.filter((name) =>
      qLower.includes(name.toLowerCase())
    );
    if (mentionedExps.length > 0) {
      // Find all chunks that belong to a mentioned expansion.
      const expChunks = chunks.filter(
        (c) => c.isExpansion === true && mentionedExps.some((name) => c.id.includes(name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")))
      );
      // Boost them to the top with a high score.
      for (const ec of expChunks) {
        const boosted: ScoredChunk = { ...ec, score: 90 };
        candidates = candidates.filter((c) => c.page !== ec.page);
        candidates.unshift(boosted);
      }
    }
  }

  // 6. Re-rank with LLM — but skip it when it isn't needed: that's a full
  // LLM round trip (up to 30 s on the local model) saved for easy questions.
  // Skip when the question names an explicit page (already boosted above),
  // or when TF-IDF has a clear winner (top score ≥ 3 and ≥ 2× the runner-up)
  // AND that winner lexically contains multiple distinct query terms. A single
  // common word ("turn", "setup") can inflate one chunk's TF-IDF score while it
  // is actually irrelevant — in that case the LLM quality gate must run.
  const topScore = candidates[0]?.score ?? 0;
  const runnerUpScore = candidates[1]?.score ?? 0;
  let skipRerank = explicitPages.length > 0;
  if (!skipRerank && topScore >= 3 && topScore >= 2 * runnerUpScore) {
    const topText = candidates[0].text.toLowerCase();
    const distinctHits = [...queryTerms].filter((t) => topText.includes(t)).length;
    skipRerank = distinctHits >= 2;
  }
  candidates = skipRerank
    ? candidates
    : await rerank(apiKey, question, candidates, queryTerms, df, chunks.length);

  // 7. Follow cross-references.
  candidates = followCrossRefs(chunks, candidates.slice(0, 6));

  // 8. Adaptive context budget — with the query terms and DF table so long
  // chunks are cut on their most relevant sentences, not from the top.
  const excerpts = adaptiveContext(candidates, 4000, queryTerms, df, chunks.length);

  // 9. Confidence.
  const confidence = estimateConfidence(candidates);

  // 10. Hierarchical TOC (combined with flat page map).
  const hToc = hierarchicalToc(chunks);
  const flatMap = pageMap(chunks).join("\n");
  const toc = hToc ? `${hToc}\n\n${flatMap}` : flatMap;

  const pages = [...new Set(candidates.map((c) => c.page))].sort((a, b) => a - b);

  return { excerpts, toc, confidence, pages };
}
