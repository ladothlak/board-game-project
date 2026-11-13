/**
 * Retrieval grader (deterministic, offline).
 *
 * Runs the RAG pipeline over a fixed set of labelled questions and checks that
 * EVERY expected answer page was actually DELIVERED in the assembled context.
 * This is the regression bar for retrieval quality: a case passes only when
 * all of its grounded pages are in `result.excerptedPages` (the pages present
 * in the context string, not just the candidate set) AND each delivers at
 * least FULL_COVERAGE_THRESHOLD of its original text — page membership alone
 * no longer counts (issue #63).
 *
 * Fully deterministic — no LLM, decision model, or network call is ever fired:
 *   - useDecisionModel: false  → keyword-heuristic classification only
 *   - skipRerank: true         → lexical candidate order is kept as-is
 *   - expansionMode: "deterministic" → the weak-base path rephrases with
 *     n-grams + the synonym map, never an LLM call (the default "llm" mode
 *     would hit the provider whenever the quality gate fails on a question
 *     longer than 20 chars)
 *
 * Run: `npx tsx scripts/grade-retrieval.ts` (or `npm run grade`).
 * Exit code: 0 when every case passes, 1 when any case fails.
 */
import { buildRagContext } from "../lib/rag";
import { loadIndex } from "../lib/retrieve";

interface GradeCase {
  slug: string;
  question: string;
  expectedPages: number[];
}

/**
 * The "full-coverage hit" threshold (RAG-PIPELINE-IMPROVEMENT-PLAN.md §5.2):
 * an expected page counts as delivered when at least this fraction of its
 * original text is in the excerpts. Named so the bar lives in one place.
 */
const FULL_COVERAGE_THRESHOLD = 0.6;

const GRADE_CASES: GradeCase[] = [
  // Anachrony
  { slug: "anachrony", question: "How do I set up the game?", expectedPages: [3] },
  { slug: "anachrony", question: "How do I win?", expectedPages: [10, 11] },
  { slug: "anachrony", question: "What happens when I get a third Paradox token?", expectedPages: [5] },
  { slug: "anachrony", question: "What happens during the Clean Up phase?", expectedPages: [6] },
  // Betrayal at House on the Hill
  { slug: "betrayal-at-house-on-the-hill", question: "How do I set up the game?", expectedPages: [3] },
  { slug: "betrayal-at-house-on-the-hill", question: "How do I win the haunt?", expectedPages: [9] },
  { slug: "betrayal-at-house-on-the-hill", question: "What happens during combat?", expectedPages: [8] },
  { slug: "betrayal-at-house-on-the-hill", question: "How do I draw Event, Item, and Omen cards?", expectedPages: [6] },
  // Brass: Birmingham
  { slug: "brass-birmingham", question: "How do I set up the game?", expectedPages: [3] },
  { slug: "brass-birmingham", question: "How do I win?", expectedPages: [6, 7] },
  { slug: "brass-birmingham", question: "How does the Build action work?", expectedPages: [5] },
  { slug: "brass-birmingham", question: "How does the Sell action work?", expectedPages: [6] },
  // Castles of Burgundy
  { slug: "castles-of-burgundy", question: "How do I set up the game?", expectedPages: [5] },
  { slug: "castles-of-burgundy", question: "How do I win?", expectedPages: [12] },
  { slug: "castles-of-burgundy", question: "What are the game phases?", expectedPages: [6] },
  { slug: "castles-of-burgundy", question: "How do I sell goods?", expectedPages: [10] },
  // Coup
  { slug: "coup", question: "How do I win?", expectedPages: [1] },
  { slug: "coup", question: "What actions can I take?", expectedPages: [1] },
  // Kabuto Sumo
  { slug: "kabuto-sumo", question: "How do I set up the game?", expectedPages: [2] },
  { slug: "kabuto-sumo", question: "How do I win?", expectedPages: [3, 4] },
  { slug: "kabuto-sumo", question: "What happens on my turn?", expectedPages: [3] },
  // Nemesis: Retaliation
  { slug: "nemesis-retaliation", question: "How do I set up the game?", expectedPages: [8, 10] },
  { slug: "nemesis-retaliation", question: "How does the game end?", expectedPages: [9] },
  { slug: "nemesis-retaliation", question: "What happens during a player's turn?", expectedPages: [12] },
  { slug: "nemesis-retaliation", question: "How do intruders move?", expectedPages: [30] },
  // Puerto Rico
  { slug: "puerto-rico", question: "How do I set up the game?", expectedPages: [6, 7] },
  { slug: "puerto-rico", question: "How do I win?", expectedPages: [33] },
  { slug: "puerto-rico", question: "What happens during the Craftsman phase?", expectedPages: [12] },
  { slug: "puerto-rico", question: "How do I build a building?", expectedPages: [18] },
  // Tacta
  { slug: "tacta", question: "How do I set up the game?", expectedPages: [3] },
  { slug: "tacta", question: "How do I win?", expectedPages: [6] },
  { slug: "tacta", question: "How do I place my cards?", expectedPages: [4] },
  // Azul
  { slug: "azul", question: "How do I set up the game?", expectedPages: [2] },
  { slug: "azul", question: "How do I win?", expectedPages: [3, 5] },
  { slug: "azul", question: "What happens during the draft phase?", expectedPages: [3] },
  // Carcassonne
  { slug: "carcassonne", question: "How do I set up the game?", expectedPages: [1] },
  { slug: "carcassonne", question: "How do I win?", expectedPages: [4] },
  { slug: "carcassonne", question: "How do I score a completed city?", expectedPages: [3] },
  // Cascadia
  { slug: "cascadia", question: "How do I set up the game?", expectedPages: [3, 4] },
  { slug: "cascadia", question: "How do I win?", expectedPages: [9] },
  { slug: "cascadia", question: "What happens during my turn?", expectedPages: [5] },
  // Catan (2nd edition)
  { slug: "catan-2", question: "How do I set up the board?", expectedPages: [3] },
  { slug: "catan-2", question: "What is my goal in the game?", expectedPages: [16] },
  { slug: "catan-2", question: "What is the order of the phases in my turn?", expectedPages: [8] },
  // Clank
  { slug: "clank", question: "How do I set up the game?", expectedPages: [2] },
  { slug: "clank", question: "How does deck building work in Clank?", expectedPages: [4, 5] },
  { slug: "clank", question: "How does damage work?", expectedPages: [8] },
  // Dominion
  { slug: "dominion", question: "How do I set up the game?", expectedPages: [3] },
  { slug: "dominion", question: "When does the game end?", expectedPages: [6] },
  { slug: "dominion", question: "What do I do on my turn?", expectedPages: [5] },
  // Everdell
  { slug: "everdell", question: "How do I set up the game?", expectedPages: [6, 7] },
  { slug: "everdell", question: "When does the game end?", expectedPages: [14] },
  { slug: "everdell", question: "What actions can I take on my turn?", expectedPages: [8] },
  // Flash Point
  { slug: "flash-point", question: "How do I set up the game?", expectedPages: [3] },
  { slug: "flash-point", question: "What are the three phases of my turn?", expectedPages: [4] },
  { slug: "flash-point", question: "How do I extinguish fire?", expectedPages: [5] },
  // Gloomhaven
  { slug: "how-to-play-gloomhaven-official-rules-ultraboardgames", question: "How do I set up the play area?", expectedPages: [5] },
  { slug: "how-to-play-gloomhaven-official-rules-ultraboardgames", question: "What is the victory condition?", expectedPages: [16] },
  { slug: "how-to-play-gloomhaven-official-rules-ultraboardgames", question: "What happens during my turn?", expectedPages: [17, 18] },
  // Hanamikoji
  { slug: "how-to-play-hanamikoji-official-rules-ultraboardgames", question: "What actions can I take?", expectedPages: [2] },
  { slug: "how-to-play-hanamikoji-official-rules-ultraboardgames", question: "How is scoring done?", expectedPages: [1] },
  // Kingdomino
  { slug: "how-to-play-kingdomino-official-rules-ultraboardgames", question: "How do I set up the game?", expectedPages: [2] },
  { slug: "how-to-play-kingdomino-official-rules-ultraboardgames", question: "How do I place a domino?", expectedPages: [3] },
  // Munchkin
  { slug: "munchkin", question: "What happens when I look for trouble?", expectedPages: [2] },
  // Oasis
  { slug: "oasis-rules-and-questions", question: "What is the goal of the game?", expectedPages: [2] },
  { slug: "oasis-rules-and-questions", question: "What happens on my turn?", expectedPages: [3] },
  { slug: "oasis-rules-and-questions", question: "How do animals attract their own kind?", expectedPages: [4] },
  // Pandemic
  { slug: "pandemic", question: "How do I set up the game?", expectedPages: [1] },
  { slug: "pandemic", question: "What are my actions on my turn?", expectedPages: [5] },
  { slug: "pandemic", question: "How do I win?", expectedPages: [1] },
  // Patchwork
  { slug: "patchwork", question: "How do I set up the game?", expectedPages: [1] },
  { slug: "patchwork", question: "What happens during my turn?", expectedPages: [1] },
  // Sagrada
  { slug: "sagrada", question: "How do I set up the game?", expectedPages: [3, 4] },
  { slug: "sagrada", question: "How do I win?", expectedPages: [8] },
  { slug: "sagrada", question: "What actions can I take?", expectedPages: [7] },
  // Scythe
  { slug: "scythe", question: "How do I set up the game?", expectedPages: [6, 7] },
  { slug: "scythe", question: "What is the goal of the game?", expectedPages: [1, 29] },
  { slug: "scythe", question: "How does the action selection work?", expectedPages: [10] },
  // Splendor
  { slug: "splendor", question: "How do I set up the game?", expectedPages: [3] },
  { slug: "splendor", question: "How do I win?", expectedPages: [3] },
  // Viticulture
  { slug: "viticulture", question: "How do I set up the game?", expectedPages: [3] },
  { slug: "viticulture", question: "What actions can I take in summer?", expectedPages: [8] },
  { slug: "viticulture", question: "How do I win?", expectedPages: [1] },
  // Wingspan
  { slug: "wingspan", question: "How do I set up the game?", expectedPages: [2] },
  { slug: "wingspan", question: "What happens at the end of a round?", expectedPages: [4, 5] },
  { slug: "wingspan", question: "How do I win?", expectedPages: [11] },
];

async function main(): Promise<void> {
  // Fail fast on a missing/empty index — every case would be a vacuous miss.
  const index = await loadIndex();
  if (index.length === 0) {
    console.error("search index is empty — run `npm run build:search` first");
    process.exit(1);
  }

  // Original page text length per slug (first chunk per page — the same
  // convention measureExcerptDelivery uses) so each case's delivered char
  // count can be reported alongside the coverage ratio.
  const originalLength = new Map<string, Map<number, number>>();
  for (const c of index) {
    let m = originalLength.get(c.slug);
    if (!m) {
      m = new Map();
      originalLength.set(c.slug, m);
    }
    if (!m.has(c.page)) m.set(c.page, c.text.length);
  }

  const rows: {
    c: GradeCase;
    type: string;
    pages: number[];
    coverages: number[];
    missingCount: number;
    deliveredChars: number;
    pass: boolean;
  }[] = [];
  for (const c of GRADE_CASES) {
    const result = await buildRagContext(c.slug, c.question, "grade-key", undefined, {
      useDecisionModel: false,
      skipRerank: true,
      expansionMode: "deterministic",
    });
    // A case passes only when EVERY expected page is in the EXCERPTS (not just
    // the candidate set) AND delivers at least FULL_COVERAGE_THRESHOLD of its
    // original text (issue #63). An absent page has zero coverage.
    const coverages = c.expectedPages.map((p) => result.excerptCoverage[p] ?? 0);
    const missingCount = c.expectedPages.filter((p) => !result.excerptedPages.includes(p)).length;
    const pass = missingCount === 0 && coverages.every((cov) => cov >= FULL_COVERAGE_THRESHOLD);
    // Delivered chars across the expected pages (absent pages contribute 0).
    const deliveredChars = c.expectedPages.reduce(
      (sum, p) => sum + Math.round((result.excerptCoverage[p] ?? 0) * (originalLength.get(c.slug)?.get(p) ?? 0)),
      0
    );
    rows.push({ c, type: result.queryType, pages: result.pages, coverages, missingCount, deliveredChars, pass });
  }

  console.log("\n──────── Retrieval grade ────────");
  console.log("idx  slug                        question                                        expected  got (pages)     delivered  type            pass");
  rows.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(3)}  ${r.c.slug.padEnd(27)} ${r.c.question.slice(0, 52).padEnd(52)} [${r.c.expectedPages.join(",")}]   [${r.pages.join(",")}]   ${String(r.deliveredChars).padStart(8)}  ${r.type.padEnd(13)} ${r.pass ? "✓" : "✗"}`
    );
  });

  const passed = rows.filter((r) => r.pass).length;
  // Full-coverage hit rate: every expected page excerpted at ≥ threshold — the
  // plan's §5.2 metric, now the pass bar itself (issue #63).
  console.log(`\nhit rate (full-coverage, ≥${FULL_COVERAGE_THRESHOLD} of original text): ${passed}/${rows.length} (${(100 * passed / rows.length).toFixed(1)}%)`);

  // §5.2 metrics: in-excerpts membership (the old page-membership bar, now
  // measured against the ACTUAL excerpts), average expected-page coverage,
  // and how many expected pages are absent from the excerpts entirely.
  const allCoverages = rows.flatMap((r) => r.coverages);
  const avgCoverage = allCoverages.length > 0 ? allCoverages.reduce((a, b) => a + b, 0) / allCoverages.length : 0;
  const inExcerpts = rows.filter((r) => r.missingCount === 0).length;
  const absentPages = rows.reduce((n, r) => n + r.missingCount, 0);
  const totalExpected = rows.reduce((n, r) => n + r.c.expectedPages.length, 0);
  console.log(`in-excerpts hit rate (membership only): ${inExcerpts}/${rows.length} (${(100 * inExcerpts / rows.length).toFixed(1)}%)`);
  console.log(`average expected-page coverage: ${(100 * avgCoverage).toFixed(1)}%`);
  console.log(`expected pages absent from excerpts: ${absentPages}/${totalExpected} (${(100 * absentPages / totalExpected).toFixed(1)}%)`);

  process.exit(passed === rows.length ? 0 : 1);
}

main().catch(() => { console.error("Grade script failed"); process.exit(1); });
