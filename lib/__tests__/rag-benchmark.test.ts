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
  // Anachrony
  { slug: "anachrony", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "anachrony", question: "How do I win?", expectedType: "victory", expectedPages: [10, 11] },
  { slug: "anachrony", question: "What happens when I get a third Paradox token?", expectedType: "edge-case", expectedPages: [5] },
  { slug: "anachrony", question: "What happens during the Clean Up phase?", expectedType: "turn-structure", expectedPages: [6] },
  // Betrayal at House on the Hill
  { slug: "betrayal-at-house-on-the-hill", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "betrayal-at-house-on-the-hill", question: "How do I win the haunt?", expectedType: "victory", expectedPages: [9] },
  { slug: "betrayal-at-house-on-the-hill", question: "What happens during combat?", expectedType: "specific-rule", expectedPages: [8] },
  { slug: "betrayal-at-house-on-the-hill", question: "How do I draw Event, Item, and Omen cards?", expectedType: "turn-structure", expectedPages: [6] },
  // Brass: Birmingham
  { slug: "brass-birmingham", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "brass-birmingham", question: "How do I win?", expectedType: "victory", expectedPages: [6, 7] },
  { slug: "brass-birmingham", question: "How does the Build action work?", expectedType: "specific-rule", expectedPages: [5] },
  { slug: "brass-birmingham", question: "How does the Sell action work?", expectedType: "specific-rule", expectedPages: [6] },
  // Castles of Burgundy
  { slug: "castles-of-burgundy", question: "How do I set up the game?", expectedType: "setup", expectedPages: [5] },
  { slug: "castles-of-burgundy", question: "How do I win?", expectedType: "victory", expectedPages: [12] },
  { slug: "castles-of-burgundy", question: "What are the game phases?", expectedType: "turn-structure", expectedPages: [6] },
  { slug: "castles-of-burgundy", question: "How do I sell goods?", expectedType: "specific-rule", expectedPages: [10] },
  // Coup
  { slug: "coup", question: "How do I win?", expectedType: "victory", expectedPages: [1] },
  { slug: "coup", question: "What actions can I take?", expectedType: "specific-rule", expectedPages: [1] },
  // Kabuto Sumo
  { slug: "kabuto-sumo", question: "How do I set up the game?", expectedType: "setup", expectedPages: [2] },
  { slug: "kabuto-sumo", question: "How do I win?", expectedType: "victory", expectedPages: [3, 4] },
  { slug: "kabuto-sumo", question: "What happens on my turn?", expectedType: "turn-structure", expectedPages: [3] },
  // Nemesis: Retaliation
  { slug: "nemesis-retaliation", question: "How do I set up the game?", expectedType: "setup", expectedPages: [8, 10] },
  { slug: "nemesis-retaliation", question: "How does the game end?", expectedType: "victory", expectedPages: [9] },
  { slug: "nemesis-retaliation", question: "What happens during a player's turn?", expectedType: "turn-structure", expectedPages: [12] },
  { slug: "nemesis-retaliation", question: "How do intruders move?", expectedType: "specific-rule", expectedPages: [30] },
  // Puerto Rico
  { slug: "puerto-rico", question: "How do I set up the game?", expectedType: "setup", expectedPages: [6, 7] },
  { slug: "puerto-rico", question: "How do I win?", expectedType: "victory", expectedPages: [33] },
  { slug: "puerto-rico", question: "What happens during the Craftsman phase?", expectedType: "turn-structure", expectedPages: [12] },
  { slug: "puerto-rico", question: "How do I build a building?", expectedType: "specific-rule", expectedPages: [18] },
  // Tacta
  { slug: "tacta", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "tacta", question: "How do I win?", expectedType: "victory", expectedPages: [6] },
  { slug: "tacta", question: "How do I place my cards?", expectedType: "specific-rule", expectedPages: [4] },
  // Azul
  { slug: "azul", question: "How do I set up the game?", expectedType: "setup", expectedPages: [2] },
  { slug: "azul", question: "How do I win?", expectedType: "victory", expectedPages: [3, 5] },
  { slug: "azul", question: "What happens during the draft phase?", expectedType: "turn-structure", expectedPages: [3] },
  // Carcassonne
  { slug: "carcassonne", question: "How do I set up the game?", expectedType: "setup", expectedPages: [1] },
  { slug: "carcassonne", question: "How do I win?", expectedType: "victory", expectedPages: [4] },
  { slug: "carcassonne", question: "How do I score a completed city?", expectedType: "specific-rule", expectedPages: [3] },
  // Cascadia
  { slug: "cascadia", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3, 4] },
  { slug: "cascadia", question: "How do I win?", expectedType: "victory", expectedPages: [9] },
  { slug: "cascadia", question: "What happens during my turn?", expectedType: "turn-structure", expectedPages: [5] },
  // Catan (2nd edition)
  { slug: "catan-2", question: "How do I set up the board?", expectedType: "setup", expectedPages: [3] },
  { slug: "catan-2", question: "What is my goal in the game?", expectedType: "victory", expectedPages: [16] },
  { slug: "catan-2", question: "What is the order of the phases in my turn?", expectedType: "turn-structure", expectedPages: [8] },
  // Clank
  { slug: "clank", question: "How do I set up the game?", expectedType: "setup", expectedPages: [2] },
  { slug: "clank", question: "How does deck building work in Clank?", expectedType: "turn-structure", expectedPages: [4, 5] },
  { slug: "clank", question: "How does damage work?", expectedType: "specific-rule", expectedPages: [8] },
  // Dominion
  { slug: "dominion", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "dominion", question: "When does the game end?", expectedType: "victory", expectedPages: [6] },
  { slug: "dominion", question: "What do I do on my turn?", expectedType: "turn-structure", expectedPages: [5] },
  // Everdell
  { slug: "everdell", question: "How do I set up the game?", expectedType: "setup", expectedPages: [6, 7] },
  { slug: "everdell", question: "When does the game end?", expectedType: "victory", expectedPages: [14] },
  { slug: "everdell", question: "What actions can I take on my turn?", expectedType: "turn-structure", expectedPages: [8] },
  // Flash Point
  { slug: "flash-point", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "flash-point", question: "What are the three phases of my turn?", expectedType: "turn-structure", expectedPages: [4] },
  { slug: "flash-point", question: "How do I extinguish fire?", expectedType: "specific-rule", expectedPages: [5] },
  // Gloomhaven
  { slug: "how-to-play-gloomhaven-official-rules-ultraboardgames", question: "How do I set up the play area?", expectedType: "setup", expectedPages: [5] },
  { slug: "how-to-play-gloomhaven-official-rules-ultraboardgames", question: "What is the victory condition?", expectedType: "victory", expectedPages: [16] },
  { slug: "how-to-play-gloomhaven-official-rules-ultraboardgames", question: "What happens during my turn?", expectedType: "turn-structure", expectedPages: [17, 18] },
  // Hanamikoji
  { slug: "how-to-play-hanamikoji-official-rules-ultraboardgames", question: "What actions can I take?", expectedType: "turn-structure", expectedPages: [2] },
  { slug: "how-to-play-hanamikoji-official-rules-ultraboardgames", question: "How is scoring done?", expectedType: "victory", expectedPages: [1] },
  // Kingdomino
  { slug: "how-to-play-kingdomino-official-rules-ultraboardgames", question: "How do I set up the game?", expectedType: "setup", expectedPages: [2] },
  { slug: "how-to-play-kingdomino-official-rules-ultraboardgames", question: "How do I place a domino?", expectedType: "specific-rule", expectedPages: [3] },
  // Munchkin
  { slug: "munchkin", question: "What happens when I look for trouble?", expectedType: "specific-rule", expectedPages: [2] },
  // Oasis
  { slug: "oasis-rules-and-questions", question: "What is the goal of the game?", expectedType: "victory", expectedPages: [2] },
  { slug: "oasis-rules-and-questions", question: "What happens on my turn?", expectedType: "turn-structure", expectedPages: [3] },
  { slug: "oasis-rules-and-questions", question: "How do animals attract their own kind?", expectedType: "specific-rule", expectedPages: [4] },
  // Pandemic
  { slug: "pandemic", question: "How do I set up the game?", expectedType: "setup", expectedPages: [1] },
  { slug: "pandemic", question: "What are my actions on my turn?", expectedType: "turn-structure", expectedPages: [5] },
  { slug: "pandemic", question: "How do I win?", expectedType: "victory", expectedPages: [1] },
  // Patchwork
  { slug: "patchwork", question: "How do I set up the game?", expectedType: "setup", expectedPages: [1] },
  { slug: "patchwork", question: "What happens during my turn?", expectedType: "turn-structure", expectedPages: [1] },
  // Sagrada
  { slug: "sagrada", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3, 4] },
  { slug: "sagrada", question: "How do I win?", expectedType: "victory", expectedPages: [8] },
  { slug: "sagrada", question: "What actions can I take?", expectedType: "turn-structure", expectedPages: [7] },
  // Scythe
  { slug: "scythe", question: "How do I set up the game?", expectedType: "setup", expectedPages: [6, 7] },
  { slug: "scythe", question: "What is the goal of the game?", expectedType: "victory", expectedPages: [1, 29] },
  { slug: "scythe", question: "How does the action selection work?", expectedType: "turn-structure", expectedPages: [10] },
  // Splendor
  { slug: "splendor", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "splendor", question: "How do I win?", expectedType: "victory", expectedPages: [3] },
  // Viticulture
  { slug: "viticulture", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "viticulture", question: "What actions can I take in summer?", expectedType: "turn-structure", expectedPages: [8] },
  { slug: "viticulture", question: "How do I win?", expectedType: "victory", expectedPages: [1] },
  // Wingspan
  { slug: "wingspan", question: "How do I set up the game?", expectedType: "setup", expectedPages: [2] },
  { slug: "wingspan", question: "What happens at the end of a round?", expectedType: "turn-structure", expectedPages: [4, 5] },
  { slug: "wingspan", question: "How do I win?", expectedType: "victory", expectedPages: [11] },
];

// ─── Metrics ────────────────────────────────────────────────────────────────

/** Reciprocal rank of the first expected page in `pages` (0 if absent). */
function reciprocalRank(pages: number[], expected: number[]): number {
  for (let i = 0; i < pages.length; i++) {
    if (expected.includes(pages[i])) return 1 / (i + 1);
  }
  return 0;
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
    const candidates = retrieve(chunks, question, 8, df); // real BM25 scores (current default)
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

  // Three arms (existing + enhanced + hybrid) run sequentially over the full
  // dataset, so the live timeout is rescaled from the two-arm 25 min to 50 min.
  it("compares retrieval effectiveness across the full dataset (live only)", { skip: !LIVE, timeout: 3_000_000 }, async () => {
    // The core question of the benchmark: for each labelled question, does each
    // pipeline pull the right documentation into the answer context? We run
    // ALL THREE configurations on every case and report per-case results (so
    // the wins and losses are visible, not just averaged away) plus aggregate
    // metrics: the existing pipeline, the decision-model-enhanced pipeline,
    // and the hybrid (decision model by default, full LLM pipeline when its
    // confidence is below HYBRID_CONFIDENCE_THRESHOLD — issue #59).
    //
    // Metrics measure what the LLM actually sees, not page-number order:
    //   - in-context hit rate — any expected page is in the selected page set
    //     (`pages`; membership only, so ordering can't fake a miss).
    //   - in-excerpts hit rate — the expected page's text made it into the
    //     injected `excerpts`, checked via the `--- Page N ---` markers.
    //   - MRR / recall@3 over `rankedPages` — the pages in retrieval-relevance
    //     order, so ranking quality is scored on relevance, not page number.
    // (The old top-1/MRR/recall@3 ran over page-number order — a metric artifact
    // that counted "misses" even when the answer text was in the context.)
    interface Row {
      c: Case;
      baseMs: number;
      enhMs: number;
      hybridMs: number;
      basePages: number[];
      enhPages: number[];
      hybridPages: number[];
      baseRanked: number[];
      enhRanked: number[];
      hybridRanked: number[];
      baseExcerpts: string;
      enhExcerpts: string;
      hybridExcerpts: string;
    }
    const rows: Row[] = [];

    for (const c of DATASET) {
      const base = await timed(() =>
        buildRagContext(c.slug, c.question, KEY, undefined, { useDecisionModel: false })
      );
      const enh = await timed(() =>
        buildRagContext(c.slug, c.question, KEY, undefined, { useDecisionModel: true })
      );
      // The hybrid arm (issue #59): decision model by default, full LLM
      // pipeline when its confidence is below the threshold. It runs through
      // buildRagContext like the other arms, so it picks up the current
      // defaults automatically.
      const hybrid = await timed(() =>
        buildRagContext(c.slug, c.question, KEY, undefined, { useHybrid: true })
      );
      rows.push({
        c,
        baseMs: base.ms,
        enhMs: enh.ms,
        hybridMs: hybrid.ms,
        basePages: base.value.pages,
        enhPages: enh.value.pages,
        hybridPages: hybrid.value.pages,
        baseRanked: base.value.rankedPages,
        enhRanked: enh.value.rankedPages,
        hybridRanked: hybrid.value.rankedPages,
        baseExcerpts: base.value.excerpts,
        enhExcerpts: enh.value.excerpts,
        hybridExcerpts: hybrid.value.excerpts,
      });
    }

    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const fmtPages = (pages: number[]) => (pages.length > 0 ? pages.slice(0, 3).join(",") : "—");
    // In-context membership: any expected page is in the selected page set.
    const inContext = (pages: number[], expected: number[]) =>
      expected.some((p) => pages.includes(p)) ? "✓" : "✗";
    // Did the expected page's text make it into the injected excerpts?
    const inExcerpts = (excerpts: string, expected: number[]) =>
      expected.some((p) => excerpts.includes(`--- Page ${p} ---`)) ? "✓" : "✗";

    console.log("\n──────── RAG benchmark: retrieval effectiveness (LIVE) ────────");
    console.log(`cases: ${rows.length}`);
    console.log("idx  slug               question                                        exp      existing top-3 (rel.)   ctx exc | enhanced top-3 (rel.)   ctx exc | hybrid top-3 (rel.)   ctx exc");
    rows.forEach((r, i) => {
      console.log(
        `${String(i + 1).padStart(3)}  ${r.c.slug.padEnd(17)} ${r.c.question.slice(0, 52).padEnd(52)} [${r.c.expectedPages.join(",")}]   ${fmtPages(r.baseRanked).padEnd(16)}${inContext(r.basePages, r.c.expectedPages)} ${inExcerpts(r.baseExcerpts, r.c.expectedPages)} | ${fmtPages(r.enhRanked).padEnd(16)}${inContext(r.enhPages, r.c.expectedPages)} ${inExcerpts(r.enhExcerpts, r.c.expectedPages)} | ${fmtPages(r.hybridRanked).padEnd(16)}${inContext(r.hybridPages, r.c.expectedPages)} ${inExcerpts(r.hybridExcerpts, r.c.expectedPages)}`
      );
    });

    const baseCtxHits = rows.map((r) => (inContext(r.basePages, r.c.expectedPages) === "✓" ? 1 : 0));
    const enhCtxHits = rows.map((r) => (inContext(r.enhPages, r.c.expectedPages) === "✓" ? 1 : 0));
    const hybridCtxHits = rows.map((r) => (inContext(r.hybridPages, r.c.expectedPages) === "✓" ? 1 : 0));
    const baseExcHits = rows.map((r) => (inExcerpts(r.baseExcerpts, r.c.expectedPages) === "✓" ? 1 : 0));
    const enhExcHits = rows.map((r) => (inExcerpts(r.enhExcerpts, r.c.expectedPages) === "✓" ? 1 : 0));
    const hybridExcHits = rows.map((r) => (inExcerpts(r.hybridExcerpts, r.c.expectedPages) === "✓" ? 1 : 0));
    // Ranking metrics over relevance order (`rankedPages`), not page number.
    const baseMrr = rows.map((r) => reciprocalRank(r.baseRanked, r.c.expectedPages));
    const enhMrr = rows.map((r) => reciprocalRank(r.enhRanked, r.c.expectedPages));
    const hybridMrr = rows.map((r) => reciprocalRank(r.hybridRanked, r.c.expectedPages));
    const baseRecall = rows.map((r) => recallAtK(r.baseRanked, r.c.expectedPages));
    const enhRecall = rows.map((r) => recallAtK(r.enhRanked, r.c.expectedPages));
    const hybridRecall = rows.map((r) => recallAtK(r.hybridRanked, r.c.expectedPages));

    console.log(`existing pipeline — in-context ${pct(baseCtxHits)} | in-excerpts ${pct(baseExcHits)} | MRR (ranked) ${pct(baseMrr)} | recall@3 (ranked) ${pct(baseRecall)} | latency ~${avg(rows.map((r) => r.baseMs)).toFixed(0)} ms`);
    console.log(`enhanced pipeline — in-context ${pct(enhCtxHits)} | in-excerpts ${pct(enhExcHits)} | MRR (ranked) ${pct(enhMrr)} | recall@3 (ranked) ${pct(enhRecall)} | latency ~${avg(rows.map((r) => r.enhMs)).toFixed(0)} ms`);
    console.log(`hybrid pipeline   — in-context ${pct(hybridCtxHits)} | in-excerpts ${pct(hybridExcHits)} | MRR (ranked) ${pct(hybridMrr)} | recall@3 (ranked) ${pct(hybridRecall)} | latency ~${avg(rows.map((r) => r.hybridMs)).toFixed(0)} ms`);

    // Count the divergent cases explicitly: for each arm, the cases where it
    // puts an answer page in context and BOTH of the other arms do not. This
    // surfaces the hybrid-vs-existing (and hybrid-vs-enhanced) divergence the
    // pre-committed decision criteria need, not just existing-vs-enhanced.
    const baseOnly = rows.filter((r) => inContext(r.basePages, r.c.expectedPages) === "✓" && inContext(r.enhPages, r.c.expectedPages) === "✗" && inContext(r.hybridPages, r.c.expectedPages) === "✗").length;
    const enhOnly = rows.filter((r) => inContext(r.basePages, r.c.expectedPages) === "✗" && inContext(r.enhPages, r.c.expectedPages) === "✓" && inContext(r.hybridPages, r.c.expectedPages) === "✗").length;
    const hybridOnly = rows.filter((r) => inContext(r.basePages, r.c.expectedPages) === "✗" && inContext(r.enhPages, r.c.expectedPages) === "✗" && inContext(r.hybridPages, r.c.expectedPages) === "✓").length;
    // Cases where ALL three arms miss in-context — the ceiling of the labelled
    // dataset (questions even the full LLM pipeline can't answer), which the
    // per-arm "only" counts cannot express.
    const allMiss = rows.filter((r) => inContext(r.basePages, r.c.expectedPages) === "✗" && inContext(r.enhPages, r.c.expectedPages) === "✗" && inContext(r.hybridPages, r.c.expectedPages) === "✗").length;
    console.log(`divergence (in-context): existing-only hits ${baseOnly} | enhanced-only hits ${enhOnly} | hybrid-only hits ${hybridOnly} | all miss ${allMiss}`);

    // Harness sanity: metrics are well-defined proportions.
    expect(baseMrr.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(enhMrr.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(hybridMrr.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(rows.length).toBe(DATASET.length);
  });

  it("benchmarks BM25 lexical scoring on the full dataset (live only)", { skip: !LIVE, timeout: 1_500_000 }, async () => {
    // A/B for issue #51: run ONLY the existing pipeline (`useDecisionModel:
    // false`) with the new `scoring: "bm25"` option on every labelled case and
    // report the same aggregate metrics as the full-dataset test above, so the
    // numbers can be compared directly against the documented TF-IDF baseline
    // (PERFORMANCE-PLAN.md §Tier 4: in-context 93.8% / in-excerpts 93.8% /
    // MRR 70.9% / recall@3 81.3%). Per-case top-3 is printed so the known-miss
    // cases (Catan trading p. 14, "fight an Intruder", Nemesis setup) and the
    // known regressions (Agricola solo, Catan goal) are visible directly.
    interface Row {
      c: Case;
      ms: number;
      pages: number[];
      ranked: number[];
      excerpts: string;
    }
    const rows: Row[] = [];

    for (const c of DATASET) {
      const r = await timed(() =>
        buildRagContext(c.slug, c.question, KEY, undefined, {
          useDecisionModel: false,
          scoring: "bm25",
        })
      );
      rows.push({
        c,
        ms: r.ms,
        pages: r.value.pages,
        ranked: r.value.rankedPages,
        excerpts: r.value.excerpts,
      });
    }

    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const fmtPages = (pages: number[]) => (pages.length > 0 ? pages.slice(0, 3).join(",") : "—");
    const inContext = (pages: number[], expected: number[]) =>
      expected.some((p) => pages.includes(p)) ? "✓" : "✗";
    const inExcerpts = (excerpts: string, expected: number[]) =>
      expected.some((p) => excerpts.includes(`--- Page ${p} ---`)) ? "✓" : "✗";

    console.log("\n──────── RAG benchmark: BM25 lexical scoring (LIVE) ────────");
    console.log(`cases: ${rows.length}`);
    console.log("idx  slug               question                                        exp      top-3 (rel.)   ctx exc");
    rows.forEach((r, i) => {
      console.log(
        `${String(i + 1).padStart(3)}  ${r.c.slug.padEnd(17)} ${r.c.question.slice(0, 52).padEnd(52)} [${r.c.expectedPages.join(",")}]   ${fmtPages(r.ranked).padEnd(16)}${inContext(r.pages, r.c.expectedPages)} ${inExcerpts(r.excerpts, r.c.expectedPages)}`
      );
    });

    const ctxHits = rows.map((r) => (inContext(r.pages, r.c.expectedPages) === "✓" ? 1 : 0));
    const excHits = rows.map((r) => (inExcerpts(r.excerpts, r.c.expectedPages) === "✓" ? 1 : 0));
    const mrr = rows.map((r) => reciprocalRank(r.ranked, r.c.expectedPages));
    const recall = rows.map((r) => recallAtK(r.ranked, r.c.expectedPages));

    console.log(`BM25 (existing pipeline, scoring: "bm25") — in-context ${pct(ctxHits)} | in-excerpts ${pct(excHits)} | MRR (ranked) ${pct(mrr)} | recall@3 (ranked) ${pct(recall)} | latency ~${avg(rows.map((r) => r.ms)).toFixed(0)} ms`);
    console.log(`TF-IDF baseline to compare against (§Tier 4) — in-context 93.8% | in-excerpts 93.8% | MRR (ranked) 70.9% | recall@3 (ranked) 81.3%`);

    // Harness sanity: metrics are well-defined proportions and every case ran.
    expect(mrr.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(recall.every((x) => x >= 0 && x <= 1)).toBe(true);
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
