import { getGame } from "./games";
import { loadIndex, retrieve, pageMap, docFreqFor, tokenize, Chunk, type ScoringMode } from "./retrieve";
import { askDecisionModel, type QuestionSpec } from "./decision-model";

// Unsloth runs locally (Unsloth Studio / `unsloth run`) and exposes an
// OpenAI-compatible API, typically on http://localhost:8888.
const MODEL =
  process.env.UNSLOTH_MODEL ?? "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";

/** Resolve the Unsloth base URL at call time (not import time), so a `.env`
 * loaded after module evaluation — as in the benchmark — is honored. */
function resolveBaseUrl(): string {
  return process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";
}

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
  /** Pages cited in the excerpts, sorted by page number (display order). */
  pages: number[];
  /**
   * The selected pages in retrieval-relevance order — the candidate order
   * after re-rank + cross-ref following, deduplicated with first occurrence
   * kept. Unlike `pages`, this preserves the ranking so metrics like MRR can
   * be computed over relevance, not page number.
   */
  rankedPages: number[];
}

export interface RagOptions {
  /**
   * When true, use the fast decision model for query classification and
   * candidate relevance scoring instead of the keyword heuristic and the slow
   * LLM re-rank. Each step falls back to the existing behavior if the model is
   * unavailable, so this never degrades availability — only (hopefully)
   * improves accuracy and latency. Defaults to false to preserve the current
   * pipeline exactly (which is what the A/B benchmark compares against).
   */
  useDecisionModel?: boolean;
  /**
   * Lexical scoring mode for the base retrieval stage ("tfidf" or "bm25").
   * Defaults to "bm25" (promoted by the A/B benchmark, issue #51 — see
   * PERFORMANCE-PLAN.md §Tier 4); "tfidf" opts into the historical
   * log-saturated weighting. See `ScoringMode` in lib/retrieve.ts.
   */
  scoring?: ScoringMode;
}

// ─── LLM Helper ───────────────────────────────────────────────────────────

async function callLlm(
  apiKey: string,
  system: string,
  user: string,
  maxTokens = 500,
  timeoutMs = 30_000
): Promise<string> {
  const res = await fetch(`${resolveBaseUrl()}/chat/completions`, {
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

// ─── 1b. Decision-model classification & scoring ──────────────────────────
//
// The fast decision model (`kev-0.8b`) makes the decisions the pipeline needs
// — what kind of question this is, whether it needs rephrasing, and how
// relevant each retrieved candidate is — in batched calls that are far cheaper
// than the slow LLM they replace (classification ~0.5 s; comparative relevance
// scoring ~3 s vs up to 30 s for the LLM re-rank). These replace the keyword
// heuristic and the slow LLM re-rank when enabled via RagOptions.useDecisionModel,
// each falling back to the existing behavior if the model is unavailable.

/** The query-type options offered to the decision model (mirrors QueryType). */
const QUERY_TYPE_CRITERIA: Record<QueryType, string> = {
  setup: "Setting up, preparing, placing pieces, starting the game",
  "turn-structure": "Turn order, rounds, phases, who goes first, sequence of play",
  "specific-rule": "A specific rule, action, or what happens when you do something",
  "edge-case": "Exceptions, special situations, if/when conditions, unique cases",
  comparison: "Comparing games, expansions, or options",
  general: "Anything else — small talk, unclear, or not a rulebook question",
};

/** Ordered relevance levels for candidate scoring, lowest → highest. */
const RELEVANCE_LEVELS = [
  "no connection",
  "same topic only",
  "related background",
  "part of answer",
  "directly answers",
];

/**
 * The rubric the decision model scores against. Stated ONCE in the request
 * `state` (not repeated per question) — see the prompt notes below.
 */
const RELEVANCE_RUBRIC =
  "Rate each excerpt 0-4 for how well it answers the question. " +
  "0 = no connection to the question's topic. " +
  "1 = same general topic but no useful detail. " +
  "2 = related background, not the answer. " +
  "3 = closely related and likely contains part of the answer. " +
  "4 = directly states the rule or fact the question asks about.";

/**
 * Classify the question with the decision model: its query type and whether it
 * needs rephrasing into search variants. Returns `null` when the model is
 * unavailable so callers fall back to `classifyQuery` + the length heuristic.
 */
export async function decisionClassify(
  question: string
): Promise<{ queryType: QueryType; needsExpansion: boolean } | null> {
  const result = await askDecisionModel(question, {
    queryType: {
      type: "choice",
      instructions: "What kind of board-game rulebook question is this?",
      criteria: QUERY_TYPE_CRITERIA,
    },
    needsExpansion: {
      type: "noul",
      instructions:
        "Does this question need to be rephrased into 2-3 search phrases to find the right rulebook text, or is it already a clear, specific lookup?",
    },
  });
  if (!result) return null;

  const typeAnswer = result.answers["queryType"];
  const expAnswer = result.answers["needsExpansion"];
  const rawType = typeAnswer?.choice;
  const queryType: QueryType = rawType && rawType in QUERY_TYPE_CRITERIA
    ? (rawType as QueryType)
    : "general";
  // noul > 0.5 means "yes, it needs rephrasing".
  const needsExpansion = (expAnswer?.noul ?? 0) > 0.5;
  return { queryType, needsExpansion };
}

/**
 * Score candidate relevance with the decision model in a single batched call,
 * replacing the slow LLM re-rank. The continuous score is combined with the
 * TF-IDF score using the same weighting as `rerank`, so results stay
 * comparable. Returns `null` when the model is unavailable so callers fall
 * back to `rerank`.
 *
 * Prompt engineering notes (measured against the live endpoint, see
 * PERFORMANCE-PLAN.md §4.1):
 *
 * - Judging each excerpt in isolation clusters every score around ~2.2 on the
 *   0–4 scale — no discrimination at all. Putting the question AND every
 *   excerpt into the request `state` so the model scores candidates *relative
 *   to each other* fixes this: top-1 hit rate rises from 60% to 80% on the
 *   probe set, and the good/bad score gap triples. The rubric is stated once
 *   in `state` (repeating it per question costs tokens without helping).
 * - Only the TOP-4 shortlist is sent: comparative scoring discriminates at
 *   that scale (~3 s, inside the timeout) but breaks down with 8 candidates —
 *   scores invert (the good chunk ranks last) and the call runs 10–13 s.
 * - Previews are raw ~200-char prefix slices, NOT query-term sentence
 *   extraction. The 0.8B model judges by surface keyword overlap, and section
 *   headings carry the query terms; sentence extraction measurably hurts
 *   discrimination (top-1 0% vs 67% on the probe set).
 *
 * Cost: ~1.3 k input tokens / ~3 s per call, still far cheaper than the LLM
 * re-rank it replaces (up to 30 s).
 */
export async function decisionRerank(
  question: string,
  candidates: ScoredChunk[],
  _queryTerms?: Set<string>,
  _df?: Map<string, number>,
  _n = 0
): Promise<ScoredChunk[] | null> {
  if (candidates.length === 0) return [];

  // Comparative framing: the model sees the shortlist at once and rates each
  // candidate against the others. Only the top 4 are sent (see notes above);
  // the rest keep their TF-IDF score and order.
  const shortlist = candidates.slice(0, 4);
  const previews = shortlist.map((c) => c.text.replace(/\s+/g, " ").slice(0, 200));
  const state =
    `Question: ${question}\n\n${RELEVANCE_RUBRIC}\n\n` +
    previews.map((t, i) => `Excerpt ${i + 1}: ${t}`).join("\n\n");

  const questions: QuestionSpec = {};
  shortlist.forEach((_, i) => {
    questions[`c${i}`] = {
      type: "score",
      instructions: `Score Excerpt ${i + 1}.`,
      criteria: RELEVANCE_LEVELS,
    };
  });

  const result = await askDecisionModel(state, questions);
  if (!result) return null;

  // Combine decision-model score (weight 3) with TF-IDF score (weight 1),
  // mirroring rerank() so the final ordering is comparable to the LLM path.
  // Candidates outside the shortlist are untouched.
  const combined = candidates.map((c, i) => {
    if (i >= shortlist.length) return c;
    const s = result.answers[`c${i}`]?.score;
    if (typeof s !== "number") return c;
    return { ...c, score: c.score * 1 + s * 3 };
  });
  return combined.sort((a, b) => b.score - a.score);
}

// ─── 2. Query Expansion ────────────────────────────────────────────────────

/**
 * Small, generic synonym map: common question words → rulebook terms.
 * Kept deliberately small and game-agnostic (issue #52).
 */
const QUERY_SYNONYMS: Record<string, string[]> = {
  solo: ["solo version", "solo play"],
  plow: ["plow field"],
  trade: ["trading", "offer"],
  setup: ["set up"],
};

/**
 * Detect whether a set of LLM-generated phrases is just an echo of the
 * original question (no genuine rephrasing). A phrase counts as an echo if,
 * lowercased and punctuation-stripped, it is a substring of (or equal to)
 * the normalized question, or vice versa. Returns true when EVERY phrase
 * is an echo.
 */
export function isEcho(phrases: string[], question: string): boolean {
  const ql = question.toLowerCase().replace(/[^\w\s]/g, "").trim();
  if (phrases.length === 0) return false;
  return phrases.every((p) => {
    const pl = p.toLowerCase().replace(/[^\w\s]/g, "").trim();
    if (pl.length === 0) return true; // empty phrase is trivially an echo
    return pl === ql || ql.includes(pl) || pl.includes(ql);
  });
}

/**
 * Deterministic query expansion (no LLM, no network). Produces 2–4 search
 * phrases from the question using n-grams and a small synonym map. Pure and
 * CI-deterministic — unit-testable without any mock (issue #52).
 */
export function expandQueryDeterministic(question: string): string[] {
  const lower = question.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);

  // No usable words → nothing to expand.
  if (words.length === 0) return [question];

  const phrases = new Set<string>();

  // Synonym expansion first: for each known key present in the question,
  // append its mapped rulebook terms. These are higher-signal than n-grams,
  // so they take priority in the final slice.
  for (const [key, values] of Object.entries(QUERY_SYNONYMS)) {
    if (lower.includes(key)) {
      for (const v of values) phrases.add(v);
    }
  }

  // 2-word and 3-word sliding-window n-grams, keeping only those that
  // contain at least one "real" word (length > 2).
  for (const n of [2, 3]) {
    if (words.length < n) continue;
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n).join(" ");
      if (gram.split(" ").some((w) => w.length > 2)) {
        phrases.add(gram);
      }
    }
  }

  const result = [...phrases].slice(0, 4);
  return result.length > 0 ? result : [question];
}

/**
 * Ask the LLM to rewrite the question into 2–3 short search variants that
 * use different wording but the same meaning. Falls back to a deterministic
 * expansion (n-grams + synonym map) on any failure or echo (issue #52).
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
      `Question: "${question}"\n${typeHint}\nDo NOT repeat the original question verbatim. Use rulebook terminology for this game.\nReturn a JSON array of 2-3 search phrases.`,
      1000,
      30_000
    );
    // Parse the JSON array.
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) return expandQueryDeterministic(question);
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return expandQueryDeterministic(question);
    const phrases = arr.map((s) => String(s).trim()).filter(Boolean);
    if (phrases.length === 0) return expandQueryDeterministic(question);
    // Echo detection: if the LLM just echoed the question, fall back to
    // deterministic expansion.
    if (isEcho(phrases, question)) return expandQueryDeterministic(question);
    return phrases;
  } catch {
    return expandQueryDeterministic(question);
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
  df?: Map<string, number>,
  scoring: ScoringMode = "bm25"
): ScoredChunk[] {
  const merged = new Map<string, ScoredChunk>();

  for (const q of queries) {
    const results = retrieve(chunks, q, k, df, scoring);
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
    // Proportional allocation, minimum 100 chars so every chunk is represented
    // without low-relevance chunks crowding out the answer chunk's budget.
    const alloc = Math.max(100, Math.round((c.score / totalScore) * budget));
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
  expansionNames?: string[],
  options?: RagOptions
): Promise<RagContext> {
  const useDecision = options?.useDecisionModel === true;
  // Lexical scoring mode for the base retrieval stage. Defaults to "bm25"
  // (promoted by the A/B benchmark, issue #51); "tfidf" opts into the
  // historical log-saturated weighting (see ScoringMode in lib/retrieve.ts).
  const scoring: ScoringMode = options?.scoring ?? "bm25";

  // 1. Classify. When the decision model is enabled, classify in parallel
  // with loadIndex() so its ~0.5 s latency hides behind the index read; the
  // keyword heuristic stays as the fallback. Otherwise classify synchronously
  // (free) exactly as before.
  const classifyPromise = useDecision
    ? decisionClassify(question)
    : Promise.resolve(null);

  // 2. Detect explicit page references (e.g. "Tell me about page 14").
  const explicitPages = detectExplicitPages(question);

  const chunks = (await loadIndex()).filter((c) => c.slug === slug);
  if (chunks.length === 0) {
    return { excerpts: "", toc: "", confidence: 0, pages: [], rankedPages: [] };
  }

  // Resolve classification: the decision model's verdict when available,
  // otherwise the keyword heuristic.
  const decision = await classifyPromise;
  const queryType: QueryType = decision?.queryType ?? classifyQuery(question);

  // 3. Expand query — skip the LLM call for short or page-specific queries
  // where TF-IDF retrieval already works well on its own. When the decision
  // model gave us a verdict, also honor its "needs rephrasing" signal; on any
  // fallback we keep the original length heuristic.
  const baseNeedsExpansion = question.length > 20 && explicitPages.length === 0;
  const needsExpansion = useDecision
    ? baseNeedsExpansion && (decision ? decision.needsExpansion : true)
    : baseNeedsExpansion;
  const expandPromise = needsExpansion
    ? expandQuery(apiKey, question, queryType)
    : Promise.resolve([question]);

  // Precomputed per-slug DF table — avoids re-tokenizing every chunk on each
  // of the 2–3 retrieve() calls below.
  const df = await docFreqFor(slug);

  const queries = await expandPromise;

  // Query terms (tokenized variants) — reused by the re-rank preview and the
  // adaptive context budget so both judge relevance the same way.
  const queryTerms = new Set(queries.flatMap((q) => tokenize(q)));

  // 4. Multi-query retrieval (top 8 for re-ranking), in the configured
  // lexical scoring mode (bm25 by default; tfidf when opted in).
  let candidates = multiQueryRetrieve(chunks, queries, 8, df, scoring);

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

  // 6. Re-rank — but skip it when it isn't needed: that's a full LLM round
  // trip (up to 30 s on the local model) saved for easy questions. Skip when
  // the question names an explicit page (already boosted above), or when TF-IDF
  // has a clear winner (top score ≥ 3 and ≥ 2× the runner-up) AND that winner
  // lexically contains multiple distinct query terms. A single common word
  // ("turn", "setup") can inflate one chunk's TF-IDF score while it is actually
  // irrelevant — in that case the quality gate must run. When the decision
  // model is enabled, the quality gate is its fast batched score call (falling
  // back to the slow LLM re-rank if the model is unavailable).
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
    : useDecision
      ? (await decisionRerank(question, candidates, queryTerms, df, chunks.length)) ??
        await rerank(apiKey, question, candidates, queryTerms, df, chunks.length)
      : await rerank(apiKey, question, candidates, queryTerms, df, chunks.length);

  // 7. Follow cross-references. The slice matches the candidate pool size
  // (top-8 from multiQueryRetrieve) so pages ranking 7th and 8th stay in
  // the final set instead of being dropped before cross-ref following.
  candidates = followCrossRefs(chunks, candidates.slice(0, 8));

  // 8. Adaptive context budget — with the query terms and DF table so long
  // chunks are cut on their most relevant sentences, not from the top.
  const excerpts = adaptiveContext(candidates, 4000, queryTerms, df, chunks.length);

  // 9. Confidence.
  const confidence = estimateConfidence(candidates);

  // 10. Hierarchical TOC (combined with flat page map).
  const hToc = hierarchicalToc(chunks);
  const flatMap = pageMap(chunks).join("\n");
  const toc = hToc ? `${hToc}\n\n${flatMap}` : flatMap;

  // Pages in retrieval-relevance order (candidate order after re-rank +
  // cross-ref following), deduplicated with first occurrence kept — this is
  // the ranking metrics like MRR should be computed over.
  const rankedPages = [...new Set(candidates.map((c) => c.page))];
  // Display order: sorted by page number, as before.
  const pages = [...rankedPages].sort((a, b) => a - b);

  return { excerpts, toc, confidence, pages, rankedPages };
}
