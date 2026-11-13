/**
 * Retrieval grader (deterministic, offline).
 *
 * Runs the RAG pipeline over a fixed set of labelled questions and checks
 * that EVERY expected answer page made it into the selected page set. This is
 * the regression bar for retrieval quality: a case passes only when all of
 * its grounded pages are in `result.pages`, not just one.
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
];

async function main(): Promise<void> {
  // Fail fast on a missing/empty index — every case would be a vacuous miss.
  const index = await loadIndex();
  if (index.length === 0) {
    console.error("search index is empty — run `npm run build:search` first");
    process.exit(1);
  }

  const rows: { c: GradeCase; type: string; pages: number[]; pass: boolean }[] = [];
  for (const c of GRADE_CASES) {
    const result = await buildRagContext(c.slug, c.question, "grade-key", undefined, {
      useDecisionModel: false,
      skipRerank: true,
      expansionMode: "deterministic",
    });
    // A case passes only when EVERY expected page is in the selected set.
    const pass = c.expectedPages.every((p) => result.pages.includes(p));
    rows.push({ c, type: result.queryType, pages: result.pages, pass });
  }

  console.log("\n──────── Retrieval grade ────────");
  console.log("idx  slug                        question                                        expected  got (pages)     type            pass");
  rows.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(3)}  ${r.c.slug.padEnd(27)} ${r.c.question.slice(0, 52).padEnd(52)} [${r.c.expectedPages.join(",")}]   [${r.pages.join(",")}]   ${r.type.padEnd(13)} ${r.pass ? "✓" : "✗"}`
    );
  });

  const passed = rows.filter((r) => r.pass).length;
  console.log(`\nhit rate: ${passed}/${rows.length} (${(100 * passed / rows.length).toFixed(1)}%)`);

  process.exit(passed === rows.length ? 0 : 1);
}

main().catch(() => { console.error("Grade script failed"); process.exit(1); });
