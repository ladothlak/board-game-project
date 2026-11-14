import { getGame } from "./games";
import { loadIndex, retrieve, docFreqFor, tokenize, Chunk, type ScoringMode } from "./retrieve";
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
  | "victory"
  | "general";

export interface ScoredChunk extends Chunk {
  score: number;
  /**
   * True when this candidate's score is a bounded prior from a boost (an
   * explicit page reference, a mentioned expansion, or a section anchor)
   * rather than genuine lexical / re-rank evidence (issue #65). The quality
   * gate and the confidence estimate ignore boosted candidates so a prior
   * can never stand in for evidence.
   */
  isBoosted?: boolean;
  /**
   * True when this candidate belongs to the query type's TOC section (issue
   * #63, #65). Used for budget allocation: section-anchored pages get a
   * dominant weight in the context budget so the page most likely to carry
   * the answer receives enough text to reach full coverage. Unlike
   * `isBoosted`, this is set for ALL section pages (including ones already
   * in the candidate set from lexical retrieval), so it does not affect the
   * confidence estimate or the quality gate.
   */
  sectionAnchored?: boolean;
}

/** Per-stage wall-clock durations (ms) for one `buildRagContext` run. */
export interface RagTimings {
  /** Query expansion — time from firing until the await completed (weak base
   * retrieval), 0 when never fired because base retrieval passed the gate or
   * the question was gated off up front. Disjoint from `retrieveMs`. */
  expandMs: number;
  /** Multi-query retrieval plus the page / expansion boosts. Spans the base
   * retrieval and quality gate, and — only when the base result was weak —
   * adds the expanded re-retrieval as a separate, non-overlapping span.
   * Disjoint from `expandMs`. */
  retrieveMs: number;
  /** Re-rank stage — the LLM / decision-model call when it fired, ~0 when skipped. */
  rerankMs: number;
}

export interface RagContext {
  /** The assembled context blocks (page-labelled excerpts). */
  excerpts: string;
  /** The hierarchical TOC for orientation. */
  toc: string;
  /**
   * The resolved query type (decision-model verdict, or the keyword heuristic
   * fallback) — threaded out so callers can budget per question type
   * (issue #61).
   */
  queryType: QueryType;
  /** Confidence 0–1: how well the retrieval matched the question. */
  confidence: number;
  /** Pages cited in the excerpts, sorted by page number (display order). */
  pages: number[];
  /**
   * The selected pages in retrieval-relevance order — the candidate order
   * after re-rank + cross-ref following, deduplicated with first occurrence
   * kept. Unlike `pages`, this preserves the ranking so metrics like MRR can
   * be computed over relevance, not page number. Only contains pages actually
   * represented in the excerpts: budget-dropped pages are filtered out.
   */
  rankedPages: number[];
  /**
   * The pages actually present in the assembled `excerpts` string, parsed
   * from its `--- Page N ---` blocks (issue #63). Unlike `pages` /
   * `rankedPages` (candidate membership), a page listed here is guaranteed to
   * have delivered text — a returned page that is not in the excerpts is
   * impossible by construction. Sorted by page number.
   */
  excerptedPages: number[];
  /**
   * Per excerpted page, the ratio of delivered chars to the original page
   * text length (loaded from the search index), clamped 0..1 (issue #63). This
   * is the "full-coverage hit" metric in RAG-PIPELINE-IMPROVEMENT-PLAN.md
   * §5.2: a grade case passes only when every expected page is excerpted at
   * ≥ 0.6, not merely present in the candidate set.
   */
  excerptCoverage: Record<number, number>;
  /**
   * Per-stage wall-clock durations for this build (Tier 0 measurement, issue #55)
   * so callers can log a latency breakdown. Additive — consumers that only
   * need the context (e.g. the prewarm route) can ignore it.
   */
  timings: RagTimings;
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
   * Hybrid configuration (issue #59): run the decision-model pipeline and,
   * when its confidence estimate drops below HYBRID_CONFIDENCE_THRESHOLD,
   * re-run the full LLM pipeline and return THAT result instead. Keeps the
   * latency win on easy questions while retaining the reasoning model for the
   * hard ones. Opt-in — defaults to false so no behavioral change ships until
   * the decision-model re-evaluation is complete and recorded.
   */
  useHybrid?: boolean;
  /**
   * Lexical scoring mode for the base retrieval stage ("tfidf" or "bm25").
   * Defaults to "bm25" (promoted by the A/B benchmark, issue #51 — see
   * PERFORMANCE-PLAN.md §Tier 4); "tfidf" opts into the historical
   * log-saturated weighting. See `ScoringMode` in lib/retrieve.ts.
   */
  scoring?: ScoringMode;
  /**
   * Expansion strategy for the weak-base path (issue #60): "llm" (default)
   * fires the LLM `expandQuery` call; "deterministic" uses
   * `expandQueryDeterministic` only — no model call at all. The prewarm fast
   * path passes "deterministic" so it never touches the main model's queue.
   */
  expansionMode?: "llm" | "deterministic";
  /**
   * Skip the re-rank stage entirely, keeping lexical candidate order
   * (issue #60). The prewarm fast path sets this: a weak gate result costs
   * nothing there — prewarm is cheap and fast, not perfect; the chat route
   * remains the quality bar.
   */
  skipRerank?: boolean;
}

// ─── Prewarm head start (issue #67) ─────────────────────────────────────────

/**
 * The deterministic prefix of the enhanced RAG pipeline (issue #67): index
 * load, the per-slug DF table, base multi-query retrieval on the original
 * question, and keyword classification. A pure function of (slug, question,
 * scoring) — zero model calls — so a prewarm build and a cold request compute
 * byte-identical head starts for the same question.
 *
 * This is candidate-level work, NOT a final-answer-ready context: it must
 * never be served as a final answer. The chat route always finishes the
 * quality stages (re-rank + assembly) over it in /api/chat — see
 * `finishRagContext` and the quality flag in app/api/chat/prewarm/route.ts.
 */
export interface PrewarmHeadStart {
  /** The slug's index chunks (from loadIndex, filtered by slug). */
  chunks: Chunk[];
  /** The precomputed per-slug DF table (undefined when the index is empty). */
  df: Map<string, number> | undefined;
  /** Base multi-query retrieval candidates — genuine lexical evidence only,
   * pre-boost. This is the list the quality gate judges, so a boost can never
   * satisfy it on its own (issue #65). */
  lexicalCandidates: ScoredChunk[];
  /** Keyword classification of the question — the deterministic fallback the
   * full pipeline uses when the decision model is disabled or unavailable. */
  queryType: QueryType;
}

/**
 * Build the deterministic prefix (see PrewarmHeadStart). Cheap and pure: one
 * index read (cached by mtime), one DF table (cached per index version), one
 * BM25 retrieval, one keyword classification — zero model calls. This is the
 * work the prewarm endpoint saves for real requests (issue #67): a prewarm hit
 * skips exactly this prefix and finishes everything else in /api/chat.
 */
export async function buildPrewarmHeadStart(
  slug: string,
  question: string,
  scoring: ScoringMode = "bm25"
): Promise<PrewarmHeadStart> {
  const chunks = (await loadIndex()).filter((c) => c.slug === slug);
  const df = chunks.length > 0 ? await docFreqFor(slug) : undefined;
  const lexicalCandidates = multiQueryRetrieve(chunks, [question], 8, df, scoring);
  return { chunks, df, lexicalCandidates, queryType: classifyQuery(question) };
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

/**
 * Keyword patterns per query type (issue #66). Every pattern is anchored with
 * `\b` word boundaries so a keyword can only match as a whole word: "if" no
 * longer matches inside "difference", "turn" inside "return", or "vs" inside
 * "devs". Multi-word phrases are matched verbatim ("set up", "how do i").
 */
const TYPE_KEYWORDS: Record<QueryType, RegExp[]> = {
  setup: [/\bset up\b/, /\bsetup\b/, /\bprepare\b/, /\bbegin\b/, /\bstart\b/, /\bdeal\b/, /\bassemble\b/, /\barrange\b/],
  "turn-structure": [/\bturn\b/, /\bround\b/, /\bphases?\b/, /\border\b/, /\bsequence\b/, /\bstep\b/, /\bwho goes first\b/, /\bactions\b/],
  victory: [/\bvictory\b/, /\bwins?\b/, /\bend of the game\b/, /\bgame ends?\b/, /\bgoal of the game\b/, /\bgoal in the game\b/, /\bscoring\b/],
  "specific-rule": [/\bhow do\b/, /\bhow does\b/, /\bwhat happens\b/, /\bcan i\b/, /\bmust i\b/, /\bdo i\b/, /\brule\b/, /\bwhat is\b/, /\bwhat are\b/, /\bhow many\b/],
  "edge-case": [/\bwhen\b/, /\bexception\b/, /\binstead\b/, /\botherwise\b/, /\bunique\b/, /\bonly\b/, /\bsolo\b/, /\berrata\b/],
  comparison: [/\bcompare\b/, /\bdifference\b/, /\bversus\b/, /\bvs\b/, /\bwhich is\b/],
  general: [],
};

/**
 * Classify the question type using keyword heuristics (no LLM call needed).
 *
 * Precedence (issue #66): `victory` is checked BEFORE `edge-case`, so a
 * victory question like "When does the game end?" — which contains BOTH an
 * edge-case keyword ("when") and a victory signal ("game ends") — resolves to
 * the more specific type. Full order, most-specific first: setup → victory →
 * turn-structure → comparison → edge-case → specific-rule; `general` is the
 * fallback when nothing matches.
 */
export function classifyQuery(question: string): QueryType {
  const q = question.toLowerCase();
  for (const type of ["setup", "victory", "turn-structure", "comparison", "edge-case", "specific-rule"] as QueryType[]) {
    if (TYPE_KEYWORDS[type].some((re) => re.test(q))) return type;
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
  victory: "Victory conditions, end of game, how to win, final scoring",
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

  // Combine decision-model score (weight 3) with the lexical score (weight 1),
  // BOTH normalized to [0, 1] first — mirroring rerank() so the final ordering
  // is comparable to the LLM path, and so a bounded boost can be corrected by
  // the model's verdict (issue #65): the re-rank's swing (up to 3) dominates
  // the lexical component (max 1), so a page the evidence rates highly can
  // outrank a boosted one. Candidates outside the shortlist are untouched.
  const maxScore = Math.max(...candidates.map((c) => c.score));
  const combined = candidates.map((c, i) => {
    if (i >= shortlist.length) return c;
    const s = result.answers[`c${i}`]?.score;
    if (typeof s !== "number") return c;
    const lexNorm = maxScore > 0 ? c.score / maxScore : 0;
    return { ...c, score: lexNorm * 1 + (s / 4) * 3 };
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
  // Victory questions ("How do I win?") carry no rulebook terms of their own,
  // so the n-gram fallback alone can't rescue them (issue #68): map the
  // question word to the section's rulebook wording.
  win: ["victory condition", "end of the game"],
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

/**
 * Bounded-prior factors (issue #65): a boost is a prior, not an evidence
 * verdict — it may nudge a page's score but must stay within the re-ranker's
 * correction range, never an absolute 80/100. Section anchors add
 * +SECTION_BOOST_FACTOR over the top genuine lexical score; explicit user
 * page references and mentioned expansions are equal bounded priors at
 * +EXPLICIT_BOOST_FACTOR — the same factor, not a stronger one — so a direct
 * lexical hit that the re-rank rates highly can outrank them (see the
 * normalized combined score in `rerank` / `decisionRerank`). Both factors sit
 * inside the plan's +10–20% cap (RAG-PIPELINE-IMPROVEMENT-PLAN.md §P0.3).
 */
const SECTION_BOOST_FACTOR = 0.2;
const EXPLICIT_BOOST_FACTOR = 0.2;

/**
 * The top genuine (non-boosted) lexical score among the candidates — the
 * baseline a bounded prior is measured against (issue #65). Boosted scores
 * are never used as their own baseline, so priors can't compound.
 */
function topLexicalScore(candidates: ScoredChunk[]): number {
  let top = 0;
  for (const c of candidates) {
    if (!c.isBoosted && c.score > top) top = c.score;
  }
  return top;
}

/** A bounded prior: the top genuine score plus at most `factor` (issue #65). */
function boundedPrior(topLexical: number, factor: number): number {
  return topLexical * (1 + factor);
}

/**
 * Boost explicitly-referenced pages and mentioned-expansion chunks to the top
 * of the candidate list with BOUNDED PRIORS so they always survive in the
 * final set, regardless of lexical retrieval order (issue #58) — while staying
 * within the re-ranker's correction range (issue #65). A boost is a prior, not
 * an evidence verdict: each boosted score is capped at +EXPLICIT_BOOST_FACTOR
 * over the top genuine lexical score (never an absolute 100/90), so a direct
 * lexical hit that the re-rank rates highly can still outrank it. Applied
 * after every multiQueryRetrieve() call so a re-retrieval on expanded queries
 * keeps exactly the same boosts as the base retrieval.
 */
export function boostCandidates(
  candidates: ScoredChunk[],
  chunks: Chunk[],
  explicitPages: number[],
  expansionNames: string[] | undefined,
  question: string
): ScoredChunk[] {
  const topLexical = topLexicalScore(candidates);
  let boosted = candidates;
  // Boost explicitly-referenced pages to the top of the candidate list.
  if (explicitPages.length > 0) {
    for (const p of explicitPages) {
      const pageChunk = chunks.find((c) => c.page === p);
      if (pageChunk) {
        // Bounded prior: strong, but correctable by the re-rank.
        const pageBoost: ScoredChunk = {
          ...pageChunk,
          score: boundedPrior(topLexical, EXPLICIT_BOOST_FACTOR),
          isBoosted: true,
        };
        // Remove any existing entry for this page, then prepend.
        boosted = boosted.filter((c) => c.page !== p);
        boosted.unshift(pageBoost);
      }
    }
  }
  // Boost expansion chunks when the query mentions an expansion name.
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
      // Boost them to the top with a bounded prior.
      for (const ec of expChunks) {
        const expBoost: ScoredChunk = {
          ...ec,
          score: boundedPrior(topLexical, EXPLICIT_BOOST_FACTOR),
          isBoosted: true,
        };
        boosted = boosted.filter((c) => c.page !== ec.page);
        boosted.unshift(expBoost);
      }
    }
  }
  return boosted;
}

/**
 * The retrieval quality gate shared by the re-rank skip and the retrieve-first
 * decision (issue #58): the top candidate is a clear winner (score ≥ 3 and ≥ 2×
 * the runner-up) AND it lexically contains at least two distinct query terms.
 * A single common word ("turn", "setup") can inflate one chunk's score while
 * it is actually irrelevant — in that case the gate must not fire.
 *
 * The gate is self-enforcing (issue #65): it filters out `isBoosted`
 * candidates INSIDE, so a boost — a prior, not evidence — can never satisfy
 * the gate on its own no matter which list the caller passes. Explicit-page
 * questions no longer skip the re-rank either — their bounded prior is
 * correctable by the re-ranker.
 */
export function passesQualityGate(candidates: ScoredChunk[], queryTerms: Set<string>): boolean {
  const genuine = candidates.filter((c) => !c.isBoosted);
  const topScore = genuine[0]?.score ?? 0;
  const runnerUpScore = genuine[1]?.score ?? 0;
  if (topScore < 3 || topScore < 2 * runnerUpScore) return false;
  const topText = genuine[0].text.toLowerCase();
  return [...queryTerms].filter((t) => topText.includes(t)).length >= 2;
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

    // Combine the LLM score (weight 3) with the lexical score (weight 1),
    // BOTH normalized to [0, 1] first (issue #65). Raw-score arithmetic could
    // never let the re-rank reorder a boosted page below a direct lexical hit:
    // any positive boost gap is bigger than the re-rank's max swing. With
    // normalized components the re-rank's swing (up to 3) dominates the
    // lexical component (max 1), so a bounded prior stays correctable — a
    // page the evidence rates highly can outrank a boosted one, and a boosted
    // page the evidence endorses keeps its edge.
    const maxScore = Math.max(...candidates.map((c) => c.score));
    const combined = candidates.map((c, i) => ({
      ...c,
      score: (maxScore > 0 ? c.score / maxScore : 0) * 1 + ((scores[i] ?? 3) / 5) * 3,
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
          // Propagate the boost flag (issue #65): a boosted parent's combined
          // score is still a prior, not genuine evidence, so it must stay
          // excluded from the confidence estimate.
          extra.push({ ...target, score: c.score * 0.3, isBoosted: c.isBoosted }); // lower confidence than direct match
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
 * carry more signal than common ones.
 *
 * Every kept sentence drags its immediate neighbours (±1) with it: an answer
 * rarely stands alone, and the sentence before or after it usually carries
 * the context that makes it readable — so a page is never reduced to
 * isolated keyword fragments (issue #64). When a neighbour window doesn't fit
 * the cap, the bare sentence is kept instead, so long filler paragraphs can
 * never starve the answer. When no sentence scores at all, this degrades to a
 * plain prefix slice — never less text than a simple cut would give.
 */
function extractRelevantSentences(
  text: string,
  terms: Set<string>,
  df: Map<string, number> | undefined,
  cap: number,
  n = 0
): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  // The joined length of a set of sentence indices (one space between each).
  const lenOf = (idx: Iterable<number>): number => {
    let len = 0;
    let count = 0;
    for (const i of idx) {
      len += sentences[i].length;
      count++;
    }
    return len + Math.max(0, count - 1);
  };

  const scored = sentences.map((s, i) => {
    const lower = s.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (lower.includes(t)) score += Math.log((n + 1) / ((df?.get(t) ?? 0) + 1));
    }
    return { i, s, score };
  });

  const kept = new Set<number>();
  for (const x of scored.sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (x.score <= 0) break;
    if (kept.has(x.i)) continue;
    // Prefer the ±1 neighbour window around the kept sentence...
    const window = [x.i - 1, x.i, x.i + 1].filter(
      (j) => j >= 0 && j < sentences.length && !kept.has(j)
    );
    if (lenOf([...kept, ...window]) <= cap) {
      for (const j of window) kept.add(j);
      continue;
    }
    // ...and fall back to the bare sentence when the neighbours don't fit.
    if (lenOf([...kept, x.i]) <= cap) kept.add(x.i);
  }

  if (kept.size === 0) return text.slice(0, cap);
  const picked = [...kept].sort((a, b) => a - b);
  return picked.map((i) => sentences[i]).join(" ");
}

/**
 * The context budget in characters, configurable via RAG_CONTEXT_BUDGET.
 * Defaults to 8000 (~2000 tokens) — big enough that a multi-sentence answer
 * in the top chunk survives its allocation without truncating the excerpts.
 */
const CONTEXT_BUDGET = Number(process.env.RAG_CONTEXT_BUDGET ?? 8000);

/**
 * The minimum characters every included chunk must deliver — roughly one
 * contiguous sentence window. Small enough that a low-relevance page is still
 * represented without crowding out the answer page's budget (issue #64).
 */
const MIN_CHUNK_CHARS = 100;

/**
 * The maximum share of the budget any single page may take when several
 * pages are included (issue #64). A section-boosted page's score is a bounded
 * prior (+SECTION_BOOST_FACTOR over the top genuine lexical score), not a
 * relevance verdict — and pure score-proportional allocation lets it consume
 * most of the budget, starving the pages that actually answer the question.
 * Capping its share at half the budget and redistributing the excess to the
 * other pages (proportionally to their scores) keeps every page represented
 * without letting one dominate. A lone page takes the whole budget: with
 * nothing else to serve, the cap would only truncate the answer.
 */
const MAX_PAGE_SHARE = 0.5;

/**
 * Allocate a character budget across selected chunks in two passes:
 *
 * Pass 1 gives every chunk a floor of MIN_CHUNK_CHARS plus a share of the
 * remaining budget proportional to its relevance score, capped so no single
 * page can starve the rest (see MAX_PAGE_SHARE). A chunk that must be cut is
 * cut on its most query-relevant sentence windows (see
 * extractRelevantSentences), so an answer that sits deep in a long page
 * survives instead of being sliced off from the top — and every included page
 * keeps at least one contiguous window, never zero chars. A chunk whose whole
 * text fits its allocation is delivered in full: sentence filtering only
 * applies to chunks that must be cut, so a fitting page never loses text it
 * could afford.
 *
 * Pass 2 hands whatever budget pass 1 left unused — the sparse pages that
 * delivered less than they could — to the truncated pages, most relevant
 * first: spare characters are worth most on the page most likely to carry the
 * answer, so each truncated page is filled up to its shortfall (or the
 * remaining budget) before the next is touched. Every fill is bounded by the
 * remaining budget, so the total can never exceed it.
 *
 * A page that cannot fit its minimum window within the budget is dropped from
 * the assembly entirely (and buildRagContext drops it from `pages` /
 * `rankedPages`), so a page is never claimed without delivered text — no
 * phantom pages.
 */
export function adaptiveContext(
  selected: ScoredChunk[],
  budget = CONTEXT_BUDGET,
  queryTerms?: Set<string>,
  df?: Map<string, number>,
  n = 0
): string {
  if (selected.length === 0) return "";

  // Feasibility first: every included chunk needs its MIN_CHUNK_CHARS floor, so
  // drop trailing (lowest-relevance) chunks until the floors fit in the budget.
  // Dropped chunks are absent from the assembled string, and buildRagContext
  // excludes their pages from `pages`/`rankedPages` — a page is never claimed
  // without delivered text.
  const feasible: ScoredChunk[] = [];
  for (const c of selected) {
    if ((feasible.length + 1) * MIN_CHUNK_CHARS <= budget) feasible.push(c);
    else break;
  }
  if (feasible.length === 0) return "";

  // Per-chunk allocation: every chunk keeps its MIN_CHUNK_CHARS floor, and the
  // remaining budget is distributed proportionally to relevance score — capped
  // so no single page (e.g. a section-boosted one) can starve the rest. Any
  // share above the cap is redistributed to the uncapped pages, proportionally
  // to their scores; each round freezes at least one page at the cap, so this
  // terminates in at most n rounds. Rounding leaves a little headroom that
  // pass 2 redistributes.
  // Per-page caps: section-anchored / boosted pages get a higher cap so the
  // page most likely to carry the answer can receive enough text to reach full
  // coverage (issue #65). Other pages keep the standard cap so no single
  // non-boosted page starves the rest.
  const MAX_BOOSTED_PAGE_SHARE = 0.75;
  const pageCapOf = (c: ScoredChunk) =>
    feasible.length === 1 ? budget : Math.floor((c.sectionAnchored || c.isBoosted ? MAX_BOOSTED_PAGE_SHARE : MAX_PAGE_SHARE) * budget);
  const allocs = feasible.map(() => MIN_CHUNK_CHARS);
  let free = budget - feasible.length * MIN_CHUNK_CHARS;
  // Budget weights: boosted candidates get a dominant fixed weight so the
  // section-anchored / explicitly-referenced page — the one most likely to
  // carry the answer — receives a large share of the context budget. The
  // actual score stays bounded (issue #65); only the allocation weight is
  // amplified, so the re-rank can still correct the ordering and the quality
  // gate / confidence remain independent of the boost magnitude. Using a
  // fixed high weight (equivalent to the pre-#65 absolute 80) ensures the
  // boosted page gets enough text to reach full coverage even when many
  // candidate pages compete for the budget.
  const BUDGET_BOOST_WEIGHT = 1000;
  const weights = feasible.map((c) => (c.sectionAnchored || c.isBoosted ? BUDGET_BOOST_WEIGHT : Math.max(0, c.score)));
  for (let round = 0; round < feasible.length && free > 0; round++) {
    const open: number[] = [];
    allocs.forEach((a, i) => {
      if (a < pageCapOf(feasible[i])) open.push(i);
    });
    if (open.length === 0) break;
    const wSum = open.reduce((s, i) => s + weights[i], 0);
    if (wSum <= 0) break; // no score signal — leave the floors in place
    let given = 0;
    for (const i of open) {
      const share = Math.floor((free * weights[i]) / wSum);
      const give = Math.min(share, pageCapOf(feasible[i]) - allocs[i]);
      if (give > 0) {
        allocs[i] += give;
        given += give;
      }
    }
    if (given === 0) break; // every share rounded to zero — nothing left to give
    free -= given;
  }

  // Deliver a chunk's text under its cap: the whole text when it fits (a
  // fitting page never loses text to sentence filtering), otherwise the most
  // query-relevant sentence windows.
  const excerptFor = (c: ScoredChunk, cap: number): string =>
    c.text.length <= cap
      ? c.text
      : extractRelevantSentences(c.text, queryTerms ?? new Set<string>(), df, cap, n);

  // Pass 1: allocate in relevance order. Each chunk is capped at its allocation
  // and the remaining budget; because the allocations sum to ≤ budget and each
  // floor is ≤ the remaining budget, every page gets at least one contiguous
  // sentence window — though in a pathological short-window case the delivered
  // chars can fall below MIN_CHUNK_CHARS.
  const delivered: string[] = [];
  let used = 0;
  feasible.forEach((c, i) => {
    const cap = Math.min(allocs[i], budget - used);
    const text = excerptFor(c, cap);
    delivered.push(text);
    used += text.length;
  });

  // Pass 2: hand the unused budget to the truncated pages, most relevant
  // first. Each page is filled up to its shortfall (or the remaining budget)
  // before the next is touched, so spare characters land on the page most
  // likely to carry the answer; every fill is bounded by the remaining
  // budget, so the total can never exceed it. One pass suffices: after it,
  // either the budget is exhausted or every truncated page delivered in full.
  const truncated: { i: number; shortfall: number }[] = [];
  feasible.forEach((c, i) => {
    const shortfall = c.text.length - delivered[i].length;
    if (shortfall > 0) truncated.push({ i, shortfall });
  });
  // Order by compressed (sqrt) score with the boosted bonus: a section-boosted
  // page's bounded prior is not a relevance verdict, but it IS the page most
  // likely to carry the answer — so it leads the spare-budget fills. sqrt
  // compresses genuine score gaps so true lexical winners among non-boosted
  // pages still rank correctly (issue #64).
  const weightOf = (i: number) => (feasible[i].sectionAnchored || feasible[i].isBoosted ? BUDGET_BOOST_WEIGHT : Math.max(0, feasible[i].score));
  truncated.sort((a, b) => Math.sqrt(weightOf(b.i)) - Math.sqrt(weightOf(a.i)) || a.i - b.i);
  for (const t of truncated) {
    const extra = Math.min(t.shortfall, budget - used);
    if (extra <= 0) break;
    const newText = excerptFor(feasible[t.i], delivered[t.i].length + extra);
    if (newText.length > delivered[t.i].length) {
      used += newText.length - delivered[t.i].length;
      delivered[t.i] = newText;
    }
  }

  // Blocks are labelled by the citation unit — the PAGE (issue #72): with a
  // passage index each candidate is a passage, and its `parentPage` (kept
  // equal to `page`) is what the block header names. `?? c.page` keeps v1/v2
  // page-level indexes working unchanged.
  return feasible.map((c, i) => `--- Page ${c.parentPage ?? c.page} ---\n${delivered[i]}`).join("\n\n");
}

/**
 * Derive which pages are actually present in the assembled context string and
 * how much of each page's original text made it through the budget cut
 * (issue #63). Both fields are derived from the ACTUAL `--- Page N ---`
 * blocks after assembly, so a returned page that is not in the excerpts is
 * impossible by construction.
 *
 * - `excerptedPages`: the pages present, sorted by page number. A page with
 *   multiple chunks (passages of one page, base + expansion) contributes the
 *   sum of its blocks' delivered chars. With a passage index (issue #72) the
 *   blocks are labelled by `parentPage`, so this is exactly the set of
 *   parentPage values of the selected passages that delivered text.
 * - `excerptCoverage`: per excerpted page, delivered chars / original page
 *   text length, clamped 0..1. The original page text is the SUM of all
 *   passages' lengths for that page in index order — with a passage index one
 *   page is several chunks, so the first chunk alone would undercount it; for
 *   v1/v2 indexes (one chunk per page) this reduces to the old first-chunk
 *   convention. A page with no index entry (or empty text) gets 0.
 */
export function measureExcerptDelivery(
  excerpts: string,
  chunks: Chunk[]
): { excerptedPages: number[]; excerptCoverage: Record<number, number> } {
  // Delivered chars per page, parsed from the actual context blocks (the same
  // block split the pipeline tests use to inspect assembled contexts). Block
  // headers name the citation unit — the page (`parentPage`, kept equal to
  // `page`), not the passage.
  const delivered = new Map<number, number>();
  for (const part of excerpts.split(/\n\n(?=--- Page \d+ ---)/)) {
    const m = part.match(/^--- Page (\d+) ---\n([\s\S]*)$/);
    if (!m) continue;
    const page = Number(m[1]);
    delivered.set(page, (delivered.get(page) ?? 0) + m[2].length);
  }

  const excerptedPages = [...delivered.keys()].sort((a, b) => a - b);

  // Original page text length: sum of ALL passages' lengths per page in index
  // order (issue #72). `?? c.page` keeps v1/v2 page-level indexes — which have
  // no parentPage — on the old first-chunk convention.
  const pageTextLen = new Map<number, number>();
  for (const c of chunks) {
    const p = c.parentPage ?? c.page;
    pageTextLen.set(p, (pageTextLen.get(p) ?? 0) + c.text.length);
  }

  const excerptCoverage: Record<number, number> = {};
  for (const page of excerptedPages) {
    const original = pageTextLen.get(page) ?? 0;
    excerptCoverage[page] = original === 0 ? 0 : Math.min(1, delivered.get(page)! / original);
  }

  return { excerptedPages, excerptCoverage };
}

// ─── 7. Citation Confidence ────────────────────────────────────────────────

/**
 * Confidence floor for the hybrid configuration (issue #59): when the
 * decision-model pipeline's own confidence estimate drops below this, its
 * retrieval was weak enough that the full LLM pipeline gets a chance to
 * answer instead. Named so the threshold is tunable in one place.
 */
export const HYBRID_CONFIDENCE_THRESHOLD = 0.25;

/**
 * Estimate retrieval confidence (0-1) based on how well the top chunks score
 * relative to the maximum possible. Used to decide whether to answer or say
 * "this isn't covered in the rulebook."
 *
 * Boost magnitude is ignored (issue #65): a boost is a prior, not evidence, so
 * only genuine lexical / re-rank scores count toward confidence. When every
 * candidate is a boost there is no evidence at all and confidence is 0 — a
 * boosted query can never saturate to 1.0 on the strength of its boost alone.
 */
export function estimateConfidence(selected: ScoredChunk[]): number {
  const genuine = selected.filter((c) => !c.isBoosted);
  if (genuine.length === 0) return 0;
  const top = Math.max(...genuine.map((c) => c.score));
  // Normalize: a score of 10+ is very confident, 3+ is moderate, <2 is weak.
  return Math.min(1, top / 10);
}

// ─── 8. Hierarchical TOC ───────────────────────────────────────────────────

/**
 * Section detection patterns shared by hierarchicalToc and findSectionPages:
 * common rulebook section headers mapped to their TOC section names. Each
 * pattern is tested against the first 200 chars of a page's text.
 */
const SECTION_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "Introduction / Overview", pattern: /\b(introduction|overview|welcome|about)\b/i },
  { name: "Setup", pattern: /\b(setup|set up|prepare|beginning|start)\b/i },
  { name: "Game Structure / Turn Order", pattern: /\b(turn|round|phase|order|structure)\b/i },
  { name: "Core Rules", pattern: /\b(rule|action|play|move|turn)\b/i },
  { name: "Combat / Conflict", pattern: /\b(combat|attack|assault|fight|battle)\b/i },
  { name: "Special Abilities / Keywords", pattern: /\b(ability|keyword|special|unique|trait)\b/i },
  { name: "Victory / End of Game", pattern: /\b(victory|win|end|defeat|lose|score|scoring|objective|goal|endgame)\b/i },
  { name: "Reference / Quick Play", pattern: /\b(reference|quick|cheat|summary|card)\b/i },
];

/**
 * Map a TOC section name to keywords that may appear in a schema v2
 * `sectionPath`. Used by findSectionPages (hoisted from the function body so
 * it is not recreated on every call).
 */
const KEYWORDS: Record<string, string[]> = {
  "Setup": ["setup", "set up", "prepare", "beginning", "start"],
  "Game Structure / Turn Order": ["turn", "round", "phase", "order", "structure"],
  "Victory / End of Game": ["victory", "win", "end", "score", "scoring", "goal", "defeat", "lose"],
};

/**
 * Build a structured outline from the page map: group pages into sections.
 *
 * Schema v2 (issue #71): when chunks carry a `sectionPath` (from structural
 * heading detection at index-build time), group by that path directly — it is
 * more precise than regex-matching the first 200 chars of text. Schema v1
 * indexes (no sectionPath) fall back to the legacy keyword test.
 */
export function hierarchicalToc(chunks: Chunk[]): string {
  // Schema v2: group by sectionPath when available.
  const hasSectionPath = chunks.some(
    (c) => typeof c.sectionPath === "string" && c.sectionPath
  );

  if (hasSectionPath) {
    const sections = new Map<string, number[]>();
    for (const c of chunks) {
      const key = c.sectionPath || "Other";
      if (!sections.has(key)) sections.set(key, []);
      if (!sections.get(key)!.includes(c.page)) sections.get(key)!.push(c.page);
    }
    const lines: string[] = [];
    for (const [name, pages] of sections) {
      lines.push(`${name}: p. ${[...pages].sort((a, b) => a - b).join(", p. ")}`);
    }
    return lines.join("\n");
  }

  // Schema v1 fallback: regex-match the first 200 chars of each page's text.
  const byPage = new Map<number, string>();
  for (const c of chunks) {
    if (!byPage.has(c.page)) byPage.set(c.page, c.text);
  }

  const sections = new Map<string, number[]>();
  for (const [page, text] of byPage) {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 200);
    let matched = false;
    for (const { name, pattern } of SECTION_PATTERNS) {
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

/**
 * Find the pages whose section matches a named TOC section so retrieval can
 * be anchored to a query type's section (issue #63).
 *
 * Schema v2 (issue #71): when chunks carry a `sectionPath`, match by keyword
 * against that path (the structural heading text is more precise than the
 * legacy first-200-char regex test). Schema v1 indexes fall back to the
 * original pattern test. Returns [] when no pattern is defined for the
 * section name.
 */
function findSectionPages(chunks: Chunk[], sectionName: string): number[] {
  // Schema v2: match keywords against sectionPath.
  const hasSectionPath = chunks.some(
    (c) => typeof c.sectionPath === "string" && c.sectionPath
  );

  if (hasSectionPath) {
    // Match the TOC section's keywords against each chunk's sectionPath.
    const kws = KEYWORDS[sectionName] || [sectionName.toLowerCase()];

    const pages: number[] = [];
    const seen = new Set<number>();
    for (const c of chunks) {
      if (seen.has(c.page)) continue;
      const path = (c.sectionPath || "").toLowerCase();
      if (kws.some((kw) => path.includes(kw))) {
        pages.push(c.page);
        seen.add(c.page);
      }
    }
    return pages;
  }

  // Schema v1 fallback: first-match-wins regex test.
  const entry = SECTION_PATTERNS.find((s) => s.name === sectionName);
  if (!entry) return [];

  const byPage = new Map<number, string>();
  for (const c of chunks) {
    if (!byPage.has(c.page)) byPage.set(c.page, c.text);
  }

  const pages: number[] = [];
  for (const [page, text] of byPage) {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 200);
    // First-match-wins: only include if this section is the FIRST pattern to match,
    // matching hierarchicalToc's assignment so the TOC and retrieval agree.
    const firstMatch = SECTION_PATTERNS.find((s) => s.pattern.test(clean));
    if (firstMatch?.name === sectionName) pages.push(page);
  }
  return pages;
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
 * Query types that map cleanly to a single TOC section (issue #63): the
 * section's pages are boosted into the candidate set so the page that answers
 * the question is always in the excerpts, even when lexical retrieval can't
 * discriminate a common-word query. Types without a single-section anchor
 * ("specific-rule", "edge-case", "comparison", "general") have no entry here.
 */
const QUERY_TYPE_SECTION: Partial<Record<QueryType, string>> = {
  setup: "Setup",
  "turn-structure": "Game Structure / Turn Order",
  victory: "Victory / End of Game",
};

/**
 * Boost the query type's TOC section pages into the candidate set as BOUNDED
 * PRIORS (issue #63, #65): anchor retrieval to the classified question type's
 * section so the page that answers the question is always in the candidate
 * set, even when lexical retrieval can't discriminate a common-word query.
 * Capped at 2 pages per section to avoid consuming the entire context budget.
 *
 * The boost is a prior, not an evidence verdict (issue #65): a boosted page's
 * score is capped at +SECTION_BOOST_FACTOR over the top genuine lexical score
 * (never an absolute 80/100), so the re-rank can correct a wrong section page,
 * and the quality gate / confidence estimate can never be satisfied by the
 * boost alone. Pages already surfaced by base retrieval (including ones
 * boosted by an explicit page reference or a mentioned expansion) are left
 * alone — the boost pulls a missing section page IN, it doesn't re-rank one
 * that's already in the set.
 */
export function boostSectionPages(
  candidates: ScoredChunk[],
  chunks: Chunk[],
  queryType: QueryType
): ScoredChunk[] {
  const sectionName = QUERY_TYPE_SECTION[queryType];
  if (!sectionName) return candidates;
  const topLexical = topLexicalScore(candidates);
  const sectionPages = findSectionPages(chunks, sectionName);
  // Mark ALL section pages (including ones already in the candidate set) with
  // `sectionAnchored: true` so the budget allocator can give them a dominant
  // weight. Existing entries keep their genuine score; missing ones get a
  // bounded prior and are flagged `isBoosted` as well.
  const marked = candidates.map((c) =>
    sectionPages.includes(c.page) ? { ...c, sectionAnchored: true } : c
  );
  let boosted = marked;
  for (const p of sectionPages.slice(0, 2)) {
    // Already in the set — its score is genuine evidence (or a stronger prior),
    // so leave it alone.
    if (boosted.some((c) => c.page === p)) continue;
    const pageChunk = chunks.find((c) => c.page === p);
    if (pageChunk) {
      boosted.unshift({
        ...pageChunk,
        score: boundedPrior(topLexical, SECTION_BOOST_FACTOR),
        isBoosted: true,
        sectionAnchored: true,
      });
    }
  }
  return boosted;
}

/**
 * Finish the quality stages of the enhanced RAG pipeline over a pre-built
 * deterministic head start (issue #67): boosts, the retrieve-first quality
 * gate + expansion, re-rank, cross-reference following, adaptive context
 * budget, confidence, and hierarchical TOC. This is the exact tail of
 * `buildRagContext` — both paths share this code, so a prewarm hit (head start
 * + finish) and a cold request (`buildRagContext`) produce byte-identical
 * excerpts for the same question when the model is deterministic (CI).
 *
 * The head start (see PrewarmHeadStart) already contains the deterministic
 * prefix — index load, DF table, base retrieval, keyword classification — so
 * this function skips exactly that prefix and runs everything else. It makes
 * the SAME model calls `buildRagContext` would: when `useDecisionModel` is
 * enabled it classifies with the decision model and re-ranks with it;
 * otherwise it uses the keyword type from the head start and the LLM re-rank.
 *
 * Parity note (issue #67): with the decision model disabled (the CI
 * configuration), classification is the deterministic keyword heuristic and
 * every stage is a pure function of (head start, options), so a prewarm hit and
 * a cold request are byte-identical. With the decision model ENABLED in
 * production, both paths still run the same pipeline configuration and stages;
 * the head start skips only the deterministic prefix, and the (non-deterministic)
 * model verdicts are computed identically on both paths — so parity means "same
 * configuration and stages," not necessarily byte-identical text.
 *
 * @param classifyPromise The classification promise, fired by the caller in
 *   parallel with the head start build (`buildRagContext` does this). When
 *   omitted it is fired here — used by the prewarm-hit path, where there is no
 *   index load to hide behind.
 */
export async function finishRagContext(
  headStart: PrewarmHeadStart,
  slug: string,
  question: string,
  apiKey: string,
  expansionNames?: string[],
  options?: RagOptions,
  classifyPromise?: Promise<{ queryType: QueryType; needsExpansion: boolean } | null>
): Promise<RagContext> {
  const useDecision = options?.useDecisionModel === true;
  // Lexical scoring mode for the re-retrieval stage (must match the head
  // start's base retrieval, so both paths score identically).
  const scoring: ScoringMode = options?.scoring ?? "bm25";

  // Tier 0 measurement (issue #55): wall-clock markers around each stage so
  // callers can log a per-stage latency breakdown. Stages that are gated off
  // (no expansion needed, re-rank skipped) report ~0 ms. The base retrieval
  // already ran in the head start, so retrieveMs starts at 0 and only adds the
  // re-retrieval span when expansion fires.
  const timings: RagTimings = { expandMs: 0, retrieveMs: 0, rerankMs: 0 };

  const chunks = headStart.chunks;
  if (chunks.length === 0) {
    return {
      excerpts: "",
      toc: "",
      queryType: "general",
      confidence: 0,
      pages: [],
      rankedPages: [],
      excerptedPages: [],
      excerptCoverage: {},
      timings,
    };
  }

  const df = headStart.df;
  let lexicalCandidates = headStart.lexicalCandidates;

  // Resolve classification: the decision model's verdict when available,
  // otherwise the keyword heuristic from the head start.
  const decision = await (classifyPromise ??
    (useDecision ? decisionClassify(question) : Promise.resolve(null)));
  const queryType: QueryType = decision?.queryType ?? headStart.queryType;

  // 2. Detect explicit page references (e.g. "Tell me about page 14").
  const explicitPages = detectExplicitPages(question);

  // Query terms for the original question — used by the quality gate below and,
  // when expansion is skipped, by the re-rank preview and the adaptive context
  // budget so all stages judge relevance the same way.
  const baseTerms = new Set(tokenize(question));

  // Decide up front whether the question even needs expansion: skip the call
  // entirely for queries where retrieval already works well on its own.
  // Evidence-based gate (issue #68): expand when retrieval evidence is weak —
  // no lexical candidates, a low top genuine score, or very few content terms —
  // instead of only for long queries. The decision-model signal can only ADD to
  // the gate after it fires, never suppress a needed expansion.
  const topScore = topLexicalScore(lexicalCandidates);
  const evidenceGate =
    (lexicalCandidates.length === 0 ||
      topScore < 3 ||
      baseTerms.size <= 2) &&
    explicitPages.length === 0;
  const needsExpansion =
    evidenceGate ||
    (useDecision && decision?.needsExpansion === true && explicitPages.length === 0);

  let candidates = lexicalCandidates;

  // 4. Boost explicitly-referenced pages and mentioned-expansion chunks with
  // bounded priors (issues #58, #65).
  candidates = boostCandidates(candidates, chunks, explicitPages, expansionNames, question);

  // 4b. Boost the query type's TOC section pages as bounded priors (issues #63, #65).
  candidates = boostSectionPages(candidates, chunks, queryType);

  // Base retrieval already ran in the head start, so retrieveMs starts at 0;
  // the re-retrieval in the weak path below is timed separately and added on,
  // so the two spans never overlap.
  let retrieveMs = 0;

  // 5. Quality gate (retrieve-first, issue #58): the same quality test that
  // skips the re-rank below. When the original question alone already has a
  // clear winner, proceed without any expansion — easy questions stop paying
  // for it. Only when the base result is weak AND the question needs expansion
  // do we fire + await the expansion and re-retrieve with the expanded queries,
  // exactly as the pre-#58 pipeline did.
  // The gate filters boosted candidates internally (issue #65): a boost is
  // a prior, not evidence, so a boosted candidate can never satisfy it on
  // its own. Explicit-page questions no longer skip the re-rank either —
  // their bounded prior is correctable by the re-ranker.
  const basePassesGate = passesQualityGate(lexicalCandidates, baseTerms);
  // A section-anchored query with SOME genuine evidence (top lexical score ≥ 3)
  // doesn't need expansion: the section boost is a strong prior that the page
  // is relevant, so re-retrieving with expanded queries would only add noise
  // and dilute the context budget. The re-rank gate below remains strict
  // (issue #65): the LLM still gets a chance to correct weak results.
  const sectionAnchored = QUERY_TYPE_SECTION[queryType] !== undefined;
  const expansionSkipped = basePassesGate || (sectionAnchored && (lexicalCandidates[0]?.score ?? 0) >= 3);

  let queries: string[];
  if (!expansionSkipped && needsExpansion) {
    // Fire + await the expansion (weak base result). expandQuery catches its own
    // provider errors and falls back to deterministic expansion, so this await
    // never rejects — no fire-and-forget guard is needed. The fast path
    // (issue #60) swaps in `expandQueryDeterministic` directly: no model call,
    // so prewarm never touches the main model's queue.
    const expandStart = Date.now();
    const expanded = options?.expansionMode === "deterministic"
      ? expandQueryDeterministic(question)
      : await expandQuery(apiKey, question, queryType);
    timings.expandMs = Date.now() - expandStart;

    // Re-retrieve with the expanded queries (timed separately so retrieveMs and
    // expandMs stay disjoint). Track the pre-boost list for the genuine-evidence
    // checks below (issue #65): boosts are priors, not evidence.
    const reretrieveStart = Date.now();
    lexicalCandidates = multiQueryRetrieve(chunks, expanded, 8, df, scoring);
    candidates = boostCandidates(lexicalCandidates, chunks, explicitPages, expansionNames, question);
    candidates = boostSectionPages(candidates, chunks, queryType);
    retrieveMs += Date.now() - reretrieveStart;
    queries = expanded;
  } else {
    // Expansion was gated off (short/explicit-page question) or the base result
    // passed the gate: retrieval ran on the original question alone.
    queries = [question];
  }
  timings.retrieveMs = retrieveMs;

  // Query terms (tokenized variants) — the expanded phrases when expansion was
  // awaited, the original question when it wasn't. Reused by the re-rank
  // preview and the adaptive context budget so both judge relevance the same way.
  const queryTerms = new Set(queries.flatMap((q) => tokenize(q)));

  // 6. Re-rank — but skip it when it isn't needed: that's a full LLM round
  // trip (up to 30 s on the local model) saved for easy questions. Skip when
  // the quality gate fires (see passesQualityGate). Explicit-page questions
  // are NO LONGER skipped here (issue #65): their bounded prior is correctable
  // by the re-ranker, so the evidence gets a chance to reorder them. A
  // section-anchored query with strong genuine evidence (top lexical score ≥ 3)
  // also skips the re-rank: the section boost is a strong prior that the page
  // is relevant, and the genuine evidence confirms it — no LLM call needed.
  // When the decision model is enabled, the quality gate is its fast batched
  // score call (falling back to the slow LLM re-rank if the model is
  // unavailable). Prewarm (issue #67) stores only the deterministic head
  // start and never makes a model call; the chat route always finishes the
  // rerank via finishRagContext.
  const rerankStart = Date.now();
  const rerankSkipped =
    options?.skipRerank === true ||
    passesQualityGate(lexicalCandidates, queryTerms) ||
    (sectionAnchored && (lexicalCandidates[0]?.score ?? 0) >= 3);
  candidates = rerankSkipped
    ? candidates
    : useDecision
      ? (await decisionRerank(question, candidates, queryTerms, df, chunks.length)) ??
        await rerank(apiKey, question, candidates, queryTerms, df, chunks.length)
      : await rerank(apiKey, question, candidates, queryTerms, df, chunks.length);
  timings.rerankMs = Date.now() - rerankStart;

  // 7. Follow cross-references. The slice matches the candidate pool size
  // (top-8 from multiQueryRetrieve) so pages ranking 7th and 8th stay in
  // the final set instead of being dropped before cross-ref following.
  candidates = followCrossRefs(chunks, candidates.slice(0, 8));

  // 8. Adaptive context budget — with the query terms and DF table so long
  // chunks are cut on their most relevant sentences, not from the top.
  const excerpts = adaptiveContext(candidates, CONTEXT_BUDGET, queryTerms, df, chunks.length);

  // 9. Confidence.
  const confidence = estimateConfidence(candidates);

  // 10. Hierarchical TOC. The flat one-line-per-page map is no longer
  // included (issue #61): hierarchicalToc groups every chunk's page into a
  // section, so it already covers the whole rulebook — the flat map was
  // redundant prefill that doubled the TOC's token cost.
  const toc = hierarchicalToc(chunks);

  // 10b. Excerpt delivery measurement (issue #63): which pages are actually in
  // the assembled context, and how much of each page's original text survived
  // the budget cut — derived from the actual context string, so a returned
  // page that is not in the excerpts is impossible by construction.
  const { excerptedPages, excerptCoverage } = measureExcerptDelivery(excerpts, chunks);

  // Pages in retrieval-relevance order (candidate order after re-rank +
  // cross-ref following), deduplicated with first occurrence kept — this is
  // the ranking metrics like MRR should be computed over. Only pages that
  // actually made it into the assembled excerpts are claimed (issue #64): a
  // page that couldn't fit its minimum window within the budget is dropped
  // here, so `pages`/`rankedPages` never list text the LLM didn't see. With a
  // passage index (issue #72) candidates are passages, so their citation unit
  // is `parentPage` (`?? c.page` keeps v1/v2 indexes working).
  const excerpted = new Set(excerptedPages);
  const rankedPages = [...new Set(candidates.map((c) => c.parentPage ?? c.page))].filter((p) => excerpted.has(p));
  // Display order: sorted by page number, as before.
  const pages = [...rankedPages].sort((a, b) => a - b);

  return { excerpts, toc, queryType, confidence, pages, rankedPages, excerptedPages, excerptCoverage, timings };
}

/**
 * The full enhanced RAG pipeline:
 * 1. Classify query type
 * 2. Detect explicit page references
 * 3. Base multi-query retrieval on the original question
 * 4. Boost explicitly-referenced pages
 * 4b. Boost the query type's TOC section pages (issue #63)
 * 5. Quality gate (retrieve-first, issue #58): if the base result is weak AND
 *    the question needs expansion, fire + await the expansion and re-retrieve
 *    with the expanded queries; otherwise no expansion is ever fired
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
  // Hybrid configuration (issue #59): the decision-model pipeline by default,
  // falling back to the full LLM pipeline when its confidence estimate is low.
  // Opt-in — OFF by default so no behavioral change ships until the
  // re-evaluation decision is made and recorded. The inner calls below must
  // NOT carry `useHybrid`, or this would recurse forever.
  if (options?.useHybrid === true) {
    const inner: RagOptions = { ...options, useHybrid: undefined };
    // `fastCtx` (not `decision`) — this is a RagContext from the decision-model
    // arm, distinct from the `decision` classification verdict resolved below.
    const fastCtx = await buildRagContext(slug, question, apiKey, expansionNames, {
      ...inner,
      useDecisionModel: true,
    });
    if (fastCtx.confidence < HYBRID_CONFIDENCE_THRESHOLD) {
      // Weak retrieval — hand the question to the full LLM pipeline.
      const fullCtx = await buildRagContext(slug, question, apiKey, expansionNames, {
        ...inner,
        useDecisionModel: false,
      });
      // Accumulate timings across BOTH arms so Tier 0 per-stage logging stays
      // accurate if/when hybrid becomes the default: returning only the
      // fallback arm's RagContext would silently drop the decision-model
      // arm's expand/retrieve/rerank cost.
      fullCtx.timings = {
        expandMs: fastCtx.timings.expandMs + fullCtx.timings.expandMs,
        retrieveMs: fastCtx.timings.retrieveMs + fullCtx.timings.retrieveMs,
        rerankMs: fastCtx.timings.rerankMs + fullCtx.timings.rerankMs,
      };
      return fullCtx;
    }
    return fastCtx;
  }

  const useDecision = options?.useDecisionModel === true;
  // Lexical scoring mode for the base retrieval stage. Defaults to "bm25"
  // (promoted by the A/B benchmark, issue #51); "tfidf" opts into the
  // historical log-saturated weighting (see ScoringMode in lib/retrieve.ts).
  const scoring: ScoringMode = options?.scoring ?? "bm25";

  // 1. Classify. When the decision model is enabled, classify in parallel
  // with the head start build (which does the index load) so its ~0.5 s
  // latency hides behind the index read; the keyword heuristic stays as the
  // fallback. Otherwise classify synchronously (free) exactly as before.
  const classifyPromise = useDecision
    ? decisionClassify(question)
    : Promise.resolve(null);

  // Deterministic prefix (issue #67): index load, DF table, base multi-query
  // retrieval, keyword classification — zero model calls. Shared with the
  // prewarm route so a cold request and a prewarm hit compute byte-identical
  // head starts for the same question.
  const headStart = await buildPrewarmHeadStart(slug, question, scoring);

  // Quality stages (issue #67): boosts, retrieve-first gate + expansion,
  // re-rank, cross-ref following, adaptive budget, confidence, TOC. Shared
  // with the prewarm-hit path so both produce identical excerpts for the same
  // question.
  return finishRagContext(headStart, slug, question, apiKey, expansionNames, options, classifyPromise);
}
