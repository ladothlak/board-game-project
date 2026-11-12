import { describe, it } from "vitest";
import { retrieve, tokenize, docFreqFor, loadIndex, Chunk } from "../retrieve";

/**
 * Throwaway diagnostic (deterministic, no LLM): compare the production TF-IDF
 * scorer in lib/retrieve.ts against a BM25 variant on the 17 benchmark-missed
 * cases (plus a few control hits), to see whether term-frequency saturation
 * fixes the ranking. Evidence for RETRIEVAL-IMPROVEMENT-PLAN.md.
 */

interface Case {
  slug: string;
  question: string;
  expectedPages: number[];
}

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

// Control cases the benchmark already hits (top-3) — regression watch.
const HITS: Case[] = [
  { slug: "catan", question: "How do I set up the board?", expectedPages: [3] },
  { slug: "root", question: "How do I set up for three players?", expectedPages: [4] },
  { slug: "nemesis-lockdown", question: "How do I set up the board in Nemesis?", expectedPages: [6] },
  { slug: "container", question: "What actions can I take during my turn?", expectedPages: [2] },
];

function ngrams(s: string, n: number): string[] {
  const words = s.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
  return out;
}

/** BM25 over the same chunks, same idf shape as production, with TF saturation. */
function bm25(chunks: Chunk[], query: string, df?: Map<string, number>, k1 = 1.2, b = 0.75, withPhrases = false) {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [] as { page: number; score: number }[];
  const N = chunks.length;
  const idf = (t: string) => Math.log((N + 1) / ((df?.get(t) ?? 0) + 1)) + 1;

  // Average chunk length in tokens.
  const lens = chunks.map((c) => tokenize(c.text).length);
  const avgL = lens.reduce((a, l) => a + l, 0) / Math.max(1, lens.length);

  const qLower = query.trim().toLowerCase();
  const phrases: { gram: string; weight: number }[] = withPhrases
    ? [
        { gram: qLower, weight: 6 },
        ...ngrams(qLower, 3).filter((g) => g.split(" ").some((w) => w.length > 2)).map((g) => ({ gram: g, weight: 2.5 })),
        ...ngrams(qLower, 2).filter((g) => g.split(" ").some((w) => w.length > 2)).map((g) => ({ gram: g, weight: 1.2 })),
      ]
    : [];

  return chunks
    .map((chunk, i) => {
      const text = chunk.text.toLowerCase();
      const tfCounts = new Map<string, number>();
      for (const t of tokenize(text)) tfCounts.set(t, (tfCounts.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of qTokens) {
        const f = tfCounts.get(t) ?? 0;
        if (f > 0) {
          score += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (lens[i] / avgL))));
        }
      }
      for (const { gram, weight } of phrases) {
        if (gram.length >= 4 && text.includes(gram)) score += weight;
      }
      return { page: chunk.page, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b2) => b2.score - a.score);
}

function rankOf(pages: number[], expected: number[]): string {
  const i = pages.findIndex((p) => expected.includes(p));
  return i === -1 ? "—" : String(i + 1);
}

describe("BM25 vs TF-IDF diagnostic (throwaway, deterministic)", () => {
  it("compares ranking of missed + control cases", async () => {
    const index = await loadIndex();

    let tfTop3 = 0, bm25Top3 = 0, bm25pTop3 = 0, total = 0;

    const report = async (label: string, cases: Case[]) => {
      console.log(`\n==== ${label} ====`);
      for (const c of cases) {
        const chunks = index.filter((x) => x.slug === c.slug);
        const df = await docFreqFor(c.slug);
        const prod = retrieve(chunks, c.question, 8, df, "tfidf").map((r) => r.page);
        const b17 = bm25(chunks, c.question, df).slice(0, 17).map((r) => r.page);
        const b17p = bm25(chunks, c.question, df, 1.2, 0.75, true).slice(0, 17).map((r) => r.page);

        const rp = rankOf(prod, c.expectedPages);
        const rb = rankOf(b17, c.expectedPages);
        const rbp = rankOf(b17p, c.expectedPages);
        total++;
        if (rp !== "—" && Number(rp) <= 3) tfTop3++;
        if (rb !== "—" && Number(rb) <= 3) bm25Top3++;
        if (rbp !== "—" && Number(rbp) <= 3) bm25pTop3++;

        console.log(`"${c.question}" [${c.slug}] exp=[${c.expectedPages.join(",")}]`);
        console.log(`  production TF-IDF: rank ${rp.padEnd(3)} top-8 [${prod.join(",")}]`);
        console.log(`  BM25 (k1=1.2,b=.75): rank ${rb.padEnd(3)} top-8 [${b17.slice(0, 8).join(",")}]`);
        console.log(`  BM25 + phrases:      rank ${rbp.padEnd(3)} top-8 [${b17p.slice(0, 8).join(",")}]`);
      }
    };

    await report("MISSED (17)", MISSED);
    await report("CONTROL HITS (4)", HITS);

    console.log(`\nSUMMARY (${total} cases): top-3 hits — production TF-IDF ${tfTop3}/${total} | BM25 ${bm25Top3}/${total} | BM25+phrases ${bm25pTop3}/${total}`);
  });
});
