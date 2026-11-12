import { describe, it } from "vitest";
import { loadEnv } from "vite";
import { buildRagContext, classifyQuery, expandQuery, multiQueryRetrieve } from "../rag";
import { retrieve, tokenize, docFreqFor, loadIndex } from "../retrieve";

// Throwaway diagnostic: trace the 17 benchmark misses through every pipeline
// stage to see where each answer page leaks out. Run with RUN_LIVE_BENCH=1.
const fileEnv = loadEnv("development", process.cwd(), ["UNSLOTH_", "RUN_"]);
for (const [k, v] of Object.entries(fileEnv)) {
  if (!(k in process.env)) process.env[k] = v;
}
const KEY = process.env.UNSLOTH_API_KEY ?? "benchmark-key";
// Live gate: only contact the real endpoints when RUN_LIVE_BENCH=1 (mirrors
// rag-benchmark.test.ts). A plain `npx vitest run` must stay green and hang-free.
const LIVE = process.env.RUN_LIVE_BENCH === "1";

interface Case {
  slug: string;
  question: string;
  expectedPages: number[];
}

// The 17 cases both pipelines missed in the full benchmark (2026-11-12).
const MISSED: Case[] = [
  { slug: "agricola", question: "What happens when I plow a field?", expectedPages: [6] },
  { slug: "agricola", question: "How do I play the solo version of Agricola?", expectedPages: [9] },
  { slug: "catan", question: "How does trading work in Catan?", expectedPages: [11, 14] },
  { slug: "catan", question: "What are the number tokens used for?", expectedPages: [10] },
  { slug: "catan", question: "How do I get the Longest Road card?", expectedPages: [9] },
  { slug: "catan", question: "What is the order of the phases in my turn?", expectedPages: [8] },
  { slug: "catan", question: "What is my goal in Catan?", expectedPages: [16] },
  { slug: "container", question: "What does the errata say about paying interest?", expectedPages: [4] },
  { slug: "nemesis-lockdown", question: "What happens when an Intruder appears in a room with me?", expectedPages: [20] },
  { slug: "nemesis-lockdown", question: "How do I fight an Intruder in combat?", expectedPages: [21, 22] },
  { slug: "nemesis-lockdown", question: "What is the difference between Light and Serious wounds?", expectedPages: [23] },
  { slug: "nemesis-lockdown", question: "How do Exploration tokens work?", expectedPages: [17] },
  { slug: "nemesis-lockdown", question: "How do I play Nemesis in solo mode?", expectedPages: [30] },
  { slug: "nemesis-lockdown", question: "What is special about Crossroads rooms?", expectedPages: [31] },
  { slug: "root", question: "What is turmoil and how do I resolve it?", expectedPages: [13] },
  { slug: "root", question: "How does the Vagabond battle without warriors?", expectedPages: [20] },
  { slug: "root", question: "What are dominance cards and how do they work?", expectedPages: [21] },
];

function rankOf(pages: number[], expected: number[]): string {
  const i = pages.findIndex((p) => expected.includes(p));
  return i === -1 ? "—" : String(i + 1);
}

describe("retrieval diagnostic (throwaway)", () => {
  it("traces every missed case through the pipeline stages", { skip: !LIVE, timeout: 2_400_000 }, async () => {
    const index = await loadIndex();

    for (const c of MISSED) {
      const chunks = index.filter((x) => x.slug === c.slug);
      const df = await docFreqFor(c.slug);

      // Stage A: raw TF-IDF on the question alone.
      const raw = retrieve(chunks, c.question, 8, df);
      const rawRank = rankOf(raw.map((r) => r.page), c.expectedPages);

      // Stage B: LLM expansion + multi-query merge (the real candidate pool).
      const type = classifyQuery(c.question);
      const phrases = await expandQuery(KEY, c.question, type);
      const queries = [c.question, ...phrases];
      const merged = multiQueryRetrieve(chunks, queries, 8, df);
      const mergedRank = rankOf(merged.map((m) => m.page), c.expectedPages);

      // Stage C: full pipeline, existing mode. Report where the expected page
      // lands in the final page list (rank matters — the benchmark's recall@3
      // cutoff is what the misses tripped on), and whether its text made it
      // into the injected excerpts at all (the real end-to-end signal).
      const final = await buildRagContext(c.slug, c.question, KEY, undefined, { useDecisionModel: false });
      const finalRank = rankOf(final.pages, c.expectedPages);
      const inExcerpts = c.expectedPages.filter((p) => final.excerpts.includes(`--- Page ${p} ---`)).join(",") || "—";

      console.log(`\n# ${c.slug} :: "${c.question}" (expected [${c.expectedPages.join(",")}])`);
      console.log(`  raw TF-IDF top-8:   [${raw.map((r) => r.page).join(",")}]  expected rank: ${rawRank}`);
      console.log(`  expansion phrases:  ${JSON.stringify(phrases)}`);
      console.log(`  merged pool (${merged.length}): expected rank: ${mergedRank}  top pages: [${merged.slice(0, 8).map((m) => m.page).join(",")}]`);
      console.log(`  final context:      [${final.pages.join(",")}]  expected rank: ${finalRank}  in excerpts: [${inExcerpts}]`);
    }
  });
});
