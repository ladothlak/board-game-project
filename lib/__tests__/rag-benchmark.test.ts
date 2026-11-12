import { describe, it, expect } from "vitest";
import { loadEnv } from "vite";
import { buildRagContext, classifyQuery, decisionClassify, decisionRerank, rerank } from "../rag";
import type { QueryType } from "../rag";
import { retrieve, tokenize, docFreqFor, loadIndex } from "../retrieve";
import { askDecisionModel } from "../decision-model";

// Load `.env` so the live benchmark can reach the real endpoints. Vitest does
// not auto-load `.env` the way Next.js does at runtime, and the decision-model
// URL is resolved from the environment at call time — so populating process.env
// here (after module import) is sufficient for the live path.
const fileEnv = loadEnv("development", process.cwd(), [
  "UNSLOTH_",
  "DECISION_",
  "BRAVE_",
  "RUN_",
]);
for (const [k, v] of Object.entries(fileEnv)) {
  if (!(k in process.env)) process.env[k] = v;
}

/**
 * Benchmark: existing RAG pipeline vs. the decision-model-enhanced pipeline.
 *
 * This measures the three things the integration is meant to improve —
 * classification accuracy, retrieval quality, and latency — and compares the
 * current solution (keyword heuristics + slow LLM re-rank) against the new
 * one (fast decision model for classification + relevance scoring).
 *
 * Modes:
 *   - CI (default): deterministic. Runs the keyword baseline and validates the
 *     harness; the live decision model is not contacted, so this stays fast and
 *     green in continuous integration.
 *   - Live (`RUN_LIVE_BENCH=1`): contacts the real endpoints for genuine
 *     numbers. Slower — run it deliberately, not on every commit.
 */

const LIVE = process.env.RUN_LIVE_BENCH === "1";
// The server validates the Bearer token, so live runs must use the real key
// from `.env` (loaded above); CI runs never hit a network.
const KEY = process.env.UNSLOTH_API_KEY ?? "benchmark-key";

// ─── Labeled dataset (grounded in the real rulebooks) ──────────────────────
//
// Each entry carries a human-labelled query type and the page(s) that answer
// it, so classification accuracy and retrieval quality can be scored.

interface Case {
  slug: string;
  question: string;
  expectedType: QueryType;
  expectedPages: number[];
}

const DATASET: Case[] = [
  // Agricola
  { slug: "agricola", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "agricola", question: "What happens when I plow a field?", expectedType: "specific-rule", expectedPages: [6] },
  { slug: "agricola", question: "How do I play the solo version of Agricola?", expectedType: "edge-case", expectedPages: [9] },
  { slug: "agricola", question: "How many Minor Improvement cards does each player get at the start?", expectedType: "specific-rule", expectedPages: [3] },
  // Catan
  { slug: "catan", question: "How do I set up the board?", expectedType: "setup", expectedPages: [3] },
  { slug: "catan", question: "What is special about the desert hex?", expectedType: "specific-rule", expectedPages: [7] },
  { slug: "catan", question: "How does trading work in Catan?", expectedType: "specific-rule", expectedPages: [11, 14] },
  { slug: "catan", question: "What are the number tokens used for?", expectedType: "specific-rule", expectedPages: [10] },
  { slug: "catan", question: "How do I get the Longest Road card?", expectedType: "specific-rule", expectedPages: [9] },
  { slug: "catan", question: "What is the Distance Rule for building a settlement?", expectedType: "edge-case", expectedPages: [5] },
  { slug: "catan", question: "What is the order of the phases in my turn?", expectedType: "turn-structure", expectedPages: [8] },
  { slug: "catan", question: "What is my goal in Catan?", expectedType: "specific-rule", expectedPages: [16] },
  // Container
  { slug: "container", question: "What actions can I take during my turn?", expectedType: "turn-structure", expectedPages: [2] },
  { slug: "container", question: "How do I move my ship from the Open Sea to Auction?", expectedType: "specific-rule", expectedPages: [3] },
  { slug: "container", question: "What does the errata say about paying interest?", expectedType: "edge-case", expectedPages: [4] },
  // Nemesis: Lockdown
  { slug: "nemesis-lockdown", question: "How do I set up the board in Nemesis?", expectedType: "setup", expectedPages: [6] },
  { slug: "nemesis-lockdown", question: "When does the game end?", expectedType: "specific-rule", expectedPages: [12, 13] },
  { slug: "nemesis-lockdown", question: "What happens when an Intruder appears in a room with me?", expectedType: "edge-case", expectedPages: [20] },
  { slug: "nemesis-lockdown", question: "How do I fight an Intruder in combat?", expectedType: "specific-rule", expectedPages: [21, 22] },
  { slug: "nemesis-lockdown", question: "What is the difference between Light and Serious wounds?", expectedType: "comparison", expectedPages: [23] },
  { slug: "nemesis-lockdown", question: "How do Exploration tokens work?", expectedType: "specific-rule", expectedPages: [17] },
  { slug: "nemesis-lockdown", question: "How do I play Nemesis in solo mode?", expectedType: "edge-case", expectedPages: [30] },
  { slug: "nemesis-lockdown", question: "What is special about Crossroads rooms?", expectedType: "specific-rule", expectedPages: [31] },
  // Root
  { slug: "root", question: "How do I set up for three players?", expectedType: "setup", expectedPages: [4] },
  { slug: "root", question: "What happens when you battle another player?", expectedType: "specific-rule", expectedPages: [8] },
  { slug: "root", question: "What is turmoil and how do I resolve it?", expectedType: "edge-case", expectedPages: [13] },
  { slug: "root", question: "How does the Vagabond battle without warriors?", expectedType: "specific-rule", expectedPages: [20] },
  { slug: "root", question: "What are dominance cards and how do they work?", expectedType: "specific-rule", expectedPages: [21] },
  { slug: "root", question: "What happens during the Evening phase?", expectedType: "turn-structure", expectedPages: [11] },
  { slug: "root", question: "How do I use a card for crafting?", expectedType: "specific-rule", expectedPages: [7] },
  { slug: "root", question: "What are clearings and slots on the map?", expectedType: "specific-rule", expectedPages: [6] },
  { slug: "root", question: "How does the Marquise score victory points?", expectedType: "specific-rule", expectedPages: [10] },
];

// ─── Metrics ────────────────────────────────────────────────────────────────

/** Reciprocal rank of the first expected page in `pages` (0 if absent). */
function reciprocalRank(pages: number[], expected: number[]): number {
  for (let i = 0; i < pages.length; i++) {
    if (expected.includes(pages[i])) return 1 / (i + 1);
  }
  return 0;
}

/** 1 when the first page retrieved is an expected answer page, else 0. */
function top1Hit(pages: number[], expected: number[]): number {
  return pages.length > 0 && expected.includes(pages[0]) ? 1 : 0;
}

/** Fraction of `expected` pages present in the top-k of `pages`. */
function recallAtK(pages: number[], expected: number[], k = 3): number {
  if (expected.length === 0) return 0;
  const topk = pages.slice(0, k);
  const hits = expected.filter((p) => topk.includes(p)).length;
  return hits / expected.length;
}

/** Mean of a list, as a percentage string. */
function pct(xs: number[]): string {
  if (xs.length === 0) return "n/a";
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  return `${(avg * 100).toFixed(1)}%`;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

// ─── Benchmark ──────────────────────────────────────────────────────────────

describe("RAG decision-model benchmark", () => {
  it("benchmarks classification accuracy (keyword baseline; live when enabled)", async () => {
    const keywordHits: number[] = [];
    const decisionHits: number[] = [];
    const decisionLatencies: number[] = [];

    for (const c of DATASET) {
      // Keyword baseline — always available, deterministic.
      const kw = classifyQuery(c.question);
      keywordHits.push(kw === c.expectedType ? 1 : 0);

      if (LIVE) {
        const { value, ms } = await timed(() => decisionClassify(c.question));
        decisionLatencies.push(ms);
        decisionHits.push(value && value.queryType === c.expectedType ? 1 : 0);
      }
    }

    console.log("\n──────── RAG benchmark: classification ────────");
    console.log(`mode: ${LIVE ? "LIVE (real endpoints)" : "CI (keyword baseline only)"}`);
    console.log(`cases: ${DATASET.length}`);
    console.log(`keyword accuracy:        ${pct(keywordHits)}`);
    if (LIVE) {
      console.log(`decision-model accuracy: ${pct(decisionHits)}`);
      const avgLat = decisionLatencies.reduce((a, b) => a + b, 0) / decisionLatencies.length;
      console.log(`decision-model classify latency: ~${avgLat.toFixed(0)} ms/call`);
    } else {
      console.log("decision-model: not contacted in CI — set RUN_LIVE_BENCH=1 for real numbers");
    }

    // Harness sanity: keyword accuracy is well-defined and within [0, 1].
    const kwAcc = keywordHits.reduce((a, b) => a + b, 0) / keywordHits.length;
    expect(kwAcc).toBeGreaterThanOrEqual(0);
    expect(kwAcc).toBeLessThanOrEqual(1);
  }, LIVE ? 120_000 : 30_000);

  it("compares LLM re-rank vs decision-model scoring on a hard question (live only)", { skip: !LIVE, timeout: 300_000 }, async () => {
    // A grounded question with a known answer page. We compare the two scoring
    // mechanisms directly (bypassing the pipeline's "skip re-rank" gate) so the
    // measurement isolates the re-rank step — where the decision model's speed
    // advantage is largest, replacing a call that can take up to 30 s.
    const slug = "root";
    const question = "What is turmoil and how do I resolve it?";
    const expectedPage = 13;

    const chunks = (await loadIndex()).filter((c) => c.slug === slug);
    const df = await docFreqFor(slug);
    const candidates = retrieve(chunks, question, 8, df); // real TF-IDF scores
    const terms = new Set(tokenize(question));
    if (candidates.length === 0) throw new Error("no candidates retrieved for benchmark");

    const llm = await timed(() => rerank(KEY, question, candidates, terms, df, chunks.length));
    const dm = await timed(() => decisionRerank(question, candidates, terms, df, chunks.length));

    const llmTopCorrect = llm.value[0]?.page === expectedPage;
    const dmTopCorrect = dm.value?.[0]?.page === expectedPage;

    console.log("\n──────── RAG benchmark: re-rank regime (LIVE) ────────");
    console.log(`question: "${question}" (expected page ${expectedPage})`);
    console.log(`LLM re-rank        — ~${llm.ms.toFixed(0)} ms | top-1 correct: ${llmTopCorrect}`);
    console.log(`decision-model score — ~${dm.ms.toFixed(0)} ms | top-1 correct: ${dmTopCorrect}`);

    // Harness sanity: both mechanisms return an ordering and a well-defined verdict.
    expect(llm.value.length).toBe(candidates.length);
    expect(dm.value?.length).toBe(candidates.length);
  });

  it("compares retrieval effectiveness across the full dataset (live only)", { skip: !LIVE, timeout: 1_500_000 }, async () => {
    // The core question of the benchmark: for each labelled question, does each
    // pipeline pull the right documentation into the answer context? We run
    // BOTH pipelines on every case and report per-case results (so the wins and
    // losses are visible, not just averaged away) plus aggregate metrics:
    // top-1 hit rate, MRR, recall@3, and end-to-end latency.
    interface Row {
      c: Case;
      baseMs: number;
      enhMs: number;
      basePages: number[];
      enhPages: number[];
    }
    const rows: Row[] = [];

    for (const c of DATASET) {
      const base = await timed(() =>
        buildRagContext(c.slug, c.question, KEY, undefined, { useDecisionModel: false })
      );
      const enh = await timed(() =>
        buildRagContext(c.slug, c.question, KEY, undefined, { useDecisionModel: true })
      );
      rows.push({ c, baseMs: base.ms, enhMs: enh.ms, basePages: base.value.pages, enhPages: enh.value.pages });
    }

    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const fmtPages = (pages: number[]) => (pages.length > 0 ? pages.slice(0, 3).join(",") : "—");
    const hit = (pages: number[], expected: number[]) => expected.some((p) => pages.slice(0, 3).includes(p)) ? "✓" : "✗";

    console.log("\n──────── RAG benchmark: retrieval effectiveness (LIVE) ────────");
    console.log(`cases: ${rows.length}`);
    console.log("idx  slug               question                                        exp      existing top-3   enhanced top-3");
    rows.forEach((r, i) => {
      console.log(
        `${String(i + 1).padStart(3)}  ${r.c.slug.padEnd(17)} ${r.c.question.slice(0, 52).padEnd(52)} [${r.c.expectedPages.join(",")}]   ${fmtPages(r.basePages).padEnd(16)}${hit(r.basePages, r.c.expectedPages)}    ${fmtPages(r.enhPages).padEnd(16)}${hit(r.enhPages, r.c.expectedPages)}`
      );
    });

    const baseTop1 = rows.map((r) => top1Hit(r.basePages, r.c.expectedPages));
    const enhTop1 = rows.map((r) => top1Hit(r.enhPages, r.c.expectedPages));
    const baseMrr = rows.map((r) => reciprocalRank(r.basePages, r.c.expectedPages));
    const enhMrr = rows.map((r) => reciprocalRank(r.enhPages, r.c.expectedPages));
    const baseRecall = rows.map((r) => recallAtK(r.basePages, r.c.expectedPages));
    const enhRecall = rows.map((r) => recallAtK(r.enhPages, r.c.expectedPages));

    console.log(`existing pipeline — top-1 ${pct(baseTop1)} | MRR ${pct(baseMrr)} | recall@3 ${pct(baseRecall)} | latency ~${avg(rows.map((r) => r.baseMs)).toFixed(0)} ms`);
    console.log(`enhanced pipeline — top-1 ${pct(enhTop1)} | MRR ${pct(enhMrr)} | recall@3 ${pct(enhRecall)} | latency ~${avg(rows.map((r) => r.enhMs)).toFixed(0)} ms`);

    // Count the divergent cases explicitly: where one mode finds the answer
    // and the other does not (within top-3).
    const baseWins = rows.filter((r) => hit(r.basePages, r.c.expectedPages) === "✓" && hit(r.enhPages, r.c.expectedPages) === "✗").length;
    const enhWins = rows.filter((r) => hit(r.basePages, r.c.expectedPages) === "✗" && hit(r.enhPages, r.c.expectedPages) === "✓").length;
    const bothMiss = rows.filter((r) => hit(r.basePages, r.c.expectedPages) === "✗" && hit(r.enhPages, r.c.expectedPages) === "✗").length;
    console.log(`divergence: existing-only hits ${baseWins} | enhanced-only hits ${enhWins} | both miss ${bothMiss}`);

    // Harness sanity: metrics are well-defined proportions.
    expect(baseMrr.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(enhMrr.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(rows.length).toBe(DATASET.length);
  });

  it("measures raw decision-model call latency for scoring (live only)", { skip: !LIVE, timeout: 60_000 }, async () => {
    // A representative batched relevance-scoring call over a few candidates.
    const questions = {
      c0: { type: "score" as const, instructions: "Rate relevance. Excerpt: You win when all enemies are destroyed.", criteria: ["irrelevant", "weak", "moderate", "relevant", "direct"] },
      c1: { type: "score" as const, instructions: "Rate relevance. Excerpt: Set up the board by placing tokens.", criteria: ["irrelevant", "weak", "moderate", "relevant", "direct"] },
      c2: { type: "score" as const, instructions: "Rate relevance. Excerpt: Each turn you may attack with your forces.", criteria: ["irrelevant", "weak", "moderate", "relevant", "direct"] },
    };

    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { value, ms } = await timed(() => askDecisionModel("How do I win the game?", questions));
      expect(value).not.toBeNull();
      samples.push(ms);
    }

    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    console.log("\n──────── RAG benchmark: decision-model score call (LIVE) ────────");
    console.log(`3-candidate batched score call: ~${avg.toFixed(0)} ms (vs up to 30 s for the LLM re-rank it replaces)`);
  });
});
