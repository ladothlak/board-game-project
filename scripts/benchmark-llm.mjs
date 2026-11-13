#!/usr/bin/env node
/**
 * Benchmark: how well does the small model (LiquidAI/LFM3-1.7B-GGUF) answer
 * rulebook questions when used as the website's LLM?
 *
 * Runs the labeled 32-case dataset from lib/__tests__/rag-benchmark.test.ts
 * through the LIVE /api/chat endpoint — exactly the way a visitor's question
 * is answered (RAG context + streaming answer). Every raw answer is saved
 * for human grading:
 *
 *   logs/benchmark-llm-answers.md    — full Q&A, one section per case
 *   logs/benchmark-llm-results.json  — machine-readable per-case results
 *
 * Automatic metrics (heuristic triage — grade the answers yourself):
 *   - answered:     got a non-empty answer back (no provider error)
 *   - citation hit: the model cited at least one of the case's expected pages
 *   - hedged:       the answer contains "not sure / can't find" language
 *   - latency:      wall time per question
 *
 * WARNING — run this LAST. The first chat request loads the small model on
 * the Unsloth server, which evicts whatever is loaded (including Opencode's
 * 27B). Nothing that needs the big model can run after this starts.
 *
 * Usage: node scripts/benchmark-llm.mjs   (website must be built + started)
 */

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { spawn } from "child_process";

const root = process.cwd();

// ─── .env loading (plain KEY=VALUE parser; no dotenv dependency) ────────────
async function loadEnv() {
  let raw;
  try {
    raw = await fs.readFile(path.join(root, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (!(key in process.env)) process.env[key] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

// Resolved in resolveConfig() AFTER loadEnv() — not at module evaluation, so
// the .env values (loaded after import) are honored. See the same note in
// lib/rag.ts ("resolve at call time, not import time").
let BASE_URL;
let API_KEY;
let MODEL;
let SITE;

async function resolveConfig() {
  await loadEnv();
  BASE_URL = process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";
  API_KEY = process.env.UNSLOTH_API_KEY ?? "";
  MODEL = process.env.UNSLOTH_BENCHMARK_MODEL ?? "LiquidAI/LFM3-1.7B-GGUF";
  SITE = `http://localhost:${process.env.PORT ?? 3111}`;
  ANSWERS_MD = path.join(LOGS_DIR, `benchmark-llm-answers-${modelSlug()}.md`);
  RESULTS_JSON = path.join(LOGS_DIR, `benchmark-llm-results-${modelSlug()}.json`);
}

const LOGS_DIR = path.join(root, "logs");
// Per-model output files so results from different benchmark models coexist
// (set in resolveConfig() once MODEL is known).
let ANSWERS_MD;
let RESULTS_JSON;

function modelSlug() {
  return MODEL.split("/").pop().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// ─── Labeled dataset (mirrors lib/__tests__/rag-benchmark.test.ts) ──────────
// Each case carries the rulebook page(s) that answer it, so a citation hit is
// automatic evidence the small model found the right text.
const DATASET = [
  // Agricola
  { slug: "agricola", question: "How do I set up the game?", expectedPages: [3] },
  { slug: "agricola", question: "What happens when I plow a field?", expectedPages: [6] },
  { slug: "agricola", question: "How do I play the solo version of Agricola?", expectedPages: [9] },
  { slug: "agricola", question: "How many Minor Improvement cards does each player get at the start?", expectedPages: [3] },
  // Catan
  { slug: "catan", question: "How do I set up the board?", expectedPages: [3] },
  { slug: "catan", question: "What is special about the desert hex?", expectedPages: [7] },
  { slug: "catan", question: "How does trading work in Catan?", expectedPages: [11, 14] },
  { slug: "catan", question: "What are the number tokens used for?", expectedPages: [10] },
  { slug: "catan", question: "How do I get the Longest Road card?", expectedPages: [9] },
  { slug: "catan", question: "What is the Distance Rule for building a settlement?", expectedPages: [5] },
  { slug: "catan", question: "What is the order of the phases in my turn?", expectedPages: [8] },
  { slug: "catan", question: "What is my goal in Catan?", expectedPages: [16] },
  // Container
  { slug: "container", question: "What actions can I take during my turn?", expectedPages: [2] },
  { slug: "container", question: "How do I move my ship from the Open Sea to Auction?", expectedPages: [3] },
  { slug: "container", question: "What does the errata say about paying interest?", expectedPages: [4] },
  // Nemesis: Lockdown
  { slug: "nemesis-lockdown", question: "How do I set up the board in Nemesis?", expectedPages: [6] },
  { slug: "nemesis-lockdown", question: "When does the game end?", expectedPages: [12, 13] },
  { slug: "nemesis-lockdown", question: "What happens when an Intruder appears in a room with me?", expectedPages: [20] },
  { slug: "nemesis-lockdown", question: "How do I fight an Intruder in combat?", expectedPages: [21, 22] },
  { slug: "nemesis-lockdown", question: "What is the difference between Light and Serious wounds?", expectedPages: [23] },
  { slug: "nemesis-lockdown", question: "How do Exploration tokens work?", expectedPages: [17] },
  { slug: "nemesis-lockdown", question: "How do I play Nemesis in solo mode?", expectedPages: [30] },
  { slug: "nemesis-lockdown", question: "What is special about Crossroads rooms?", expectedPages: [31] },
  // Root
  { slug: "root", question: "How do I set up for three players?", expectedPages: [4] },
  { slug: "root", question: "What happens when you battle another player?", expectedPages: [8] },
  { slug: "root", question: "What is turmoil and how do I resolve it?", expectedPages: [13] },
  { slug: "root", question: "How does the Vagabond battle without warriors?", expectedPages: [20] },
  { slug: "root", question: "What are dominance cards and how do they work?", expectedPages: [21] },
  { slug: "root", question: "What happens during the Evening phase?", expectedPages: [11] },
  { slug: "root", question: "How do I use a card for crafting?", expectedPages: [7] },
  { slug: "root", question: "What are clearings and slots on the map?", expectedPages: [6] },
  { slug: "root", question: "How does the Marquise score victory points?", expectedPages: [10] },
];

// ─── Chat client (SSE) ──────────────────────────────────────────────────────

/**
 * Ask the website's /api/chat endpoint and consume its SSE stream.
 * Protocol: {type:"token"} chunks, then {type:"done",citations} or
 * {type:"error"}. One retry on 429 (rate limit).
 */
async function askChat(slug, question) {
  const t0 = Date.now();
  const post = () =>
    fetch(`${SITE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, question }),
      // The route caps each LLM call at 60 s, but RAG can make up to three
      // (expand + re-rank + answer), so allow the full round trip room.
      signal: AbortSignal.timeout(5 * 60_000),
    });

  let res;
  try {
    res = await post();
    if (res.status === 429) {
      const waitMs = Math.min((Number(res.headers.get("Retry-After")) || 65) * 1000, 65_000);
      await new Promise((r) => setTimeout(r, waitMs));
      res = await post();
    }
  } catch (e) {
    return { ok: false, answer: "", citations: [], ms: Date.now() - t0, error: `network: ${e.message}` };
  }

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, answer: "", citations: [], ms: Date.now() - t0, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  let answer = "";
  let citations = [];
  let error = null;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        if (j.type === "token") answer += j.content ?? "";
        else if (j.type === "done") citations = (j.citations ?? []).map((c) => c.page);
        else if (j.type === "error") error = j.message;
      } catch {
        /* ignore malformed keep-alive frames */
      }
    }
  }

  return { ok: !error && answer.trim().length > 0, answer: answer.trim(), citations, ms: Date.now() - t0, error };
}

// ─── Scoring (heuristic flags for triage — grade the answers yourself) ──────

const HEDGED_RE = /can'?t find|not sure|don.?t (?:have|know)|no clear answer|isn'?t covered/i;

function scoreCase(c, r) {
  return {
    slug: c.slug,
    question: c.question,
    expectedPages: c.expectedPages,
    answer: r.answer,
    citations: r.citations,
    ok: r.ok,
    // Did the model cite at least one of the pages that actually answer it?
    citationHit: r.ok && c.expectedPages.some((p) => r.citations.includes(p)),
    hedged: r.ok && HEDGED_RE.test(r.answer),
    ms: r.ms,
    error: r.error ?? null,
  };
}

// ─── Saving (incremental — partial results survive any interruption) ───────

async function saveResults(rows, finished = false) {
  const answered = rows.filter((r) => r.ok);
  const median = (xs) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const summary = {
    model: MODEL,
    endpoint: `${SITE}/api/chat`,
    startedAt: rows[0]?.startedAt ?? null,
    finishedAt: finished ? new Date().toISOString() : null,
    cases: rows.length,
    answered: answered.length,
    citationHits: rows.filter((r) => r.citationHit).length,
    hedged: rows.filter((r) => r.hedged).length,
    medianLatencyMs: median(rows.map((r) => r.ms)),
  };

  await fs.mkdir(LOGS_DIR, { recursive: true });
  await fs.writeFile(RESULTS_JSON, JSON.stringify({ summary, rows }, null, 2));

  const lines = [
    "# LLM answer benchmark — " + MODEL,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Endpoint: \`${SITE}/api/chat\` (model under test is the website's active LLM)`,
    "",
    "How to grade: each case lists the rulebook page(s) that answer it. A good",
    "answer uses that page's content and cites it. `citation hit` = the model",
    "cited an expected page; `hedged` = the answer contains \"not sure\"-style",
    "language (heuristic flag — verify by reading).",
    "",
  ];
  rows.forEach((r, i) => {
    lines.push(
      `## ${i + 1}. ${r.slug} — "${r.question}"`,
      "",
      `- expected pages: ${r.expectedPages.join(", ")}`,
      `- cited pages: ${r.citations.length > 0 ? r.citations.join(", ") : "(none)"}`,
      `- citation hit: ${r.citationHit ? "✓" : "✗"}`,
      `- hedged: ${r.hedged ? "⚠" : "—"}`,
      `- latency: ${(r.ms / 1000).toFixed(1)} s`,
      `- status: ${r.ok ? "ok" : `FAILED (${r.error})`}`,
      "",
      "```",
      r.answer || "(no answer)",
      "```",
      "",
    );
  });
  lines.push(
    "## Summary",
    "",
    `- answered: ${summary.answered}/${summary.cases}`,
    `- citation hits: ${summary.citationHits}/${summary.cases}`,
    `- hedged: ${summary.hedged}`,
    `- median latency: ${summary.medianLatencyMs ? (summary.medianLatencyMs / 1000).toFixed(1) + " s" : "n/a"}`,
    "",
  );
  await fs.writeFile(ANSWERS_MD, lines.join("\n"));
}

// ─── Preflight (safe: neither call loads a model) ───────────────────────────

async function preflight() {
  // 1. The small model must be listed on the Unsloth server. GET /models is
  //    read-only — it does not load anything.
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Unsloth /models returned ${res.status}`);
  const data = await res.json();
  const entry = (data.data ?? []).find((m) => m.id === MODEL);
  if (!entry) throw new Error(`model ${MODEL} is not listed on the Unsloth server`);

  // 2. The website must be up and see the provider.
  let health = null;
  try {
    const h = await fetch(`${SITE}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (h.ok) health = await h.json();
  } catch {
    /* fall through */
  }
  if (!health?.provider) throw new Error(`website ${SITE} is not healthy (provider=${health?.provider ?? "unreachable"})`);
}

// ─── Website lifecycle ──────────────────────────────────────────────────────
//
// The benchmark needs the website running with the small model as its LLM.
// Spawn it DETACHED (own session) so it survives beyond this process — and
// beyond the agent turn that launched the benchmark — because the user may
// want to try the site manually afterwards.

async function siteHealthy() {
  try {
    const h = await fetch(`${SITE}/api/health`, { signal: AbortSignal.timeout(10_000) });
    return h.ok ? (await h.json()).provider === true : false;
  } catch {
    return false;
  }
}

function startServer() {
  const logFd = fsSync.openSync(path.join(LOGS_DIR, "webserver.log"), "a");
  const proc = spawn("npm", ["start"], {
    cwd: root,
    detached: true, // new session — not killed when this process exits
    stdio: ["ignore", logFd, logFd],
  });
  proc.unref();
}

async function ensureSiteUp() {
  if (await siteHealthy()) return;
  console.log("website not up — starting it detached (npm start)");
  await fs.mkdir(LOGS_DIR, { recursive: true });
  startServer();
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    if (await siteHealthy()) return;
  }
  throw new Error("website did not become healthy within 90 s");
}

// ─── Main ───────────────────────────────────────────────────────────────────

const startedAt = new Date().toISOString();
await resolveConfig();
// Start the website (detached) if needed BEFORE preflight, which verifies it.
await ensureSiteUp();
await preflight();

console.log(`──────── LLM answer benchmark: ${MODEL} ────────`);
console.log(`endpoint: ${SITE}/api/chat | cases: ${DATASET.length}`);

const rows = [];
for (let i = 0; i < DATASET.length; i++) {
  const c = DATASET[i];
  process.stdout.write(
    `[${i + 1}/${DATASET.length}] ${c.slug}: ${c.question.slice(0, 58).padEnd(58)}`
  );
  const r = await askChat(c.slug, c.question);
  const row = scoreCase(c, r);
  row.startedAt = startedAt;
  rows.push(row);
  process.stdout.write(`${(r.ms / 1000).toFixed(1)}s ${r.ok ? (row.citationHit ? "✓ cite" : "ok") : `FAIL (${r.error})`}\n`);
  // Save incrementally so a crash mid-run still leaves gradable answers.
  await saveResults(rows);
}

await saveResults(rows, true);

const answered = rows.filter((r) => r.ok).length;
const hits = rows.filter((r) => r.citationHit).length;
const hedged = rows.filter((r) => r.hedged).length;
const medianMs = [...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)];

console.log(`answered:     ${answered}/${rows.length}`);
console.log(`citation hits: ${hits}/${rows.length}`);
console.log(`hedged:        ${hedged}`);
console.log(`median latency: ${(medianMs / 1000).toFixed(1)} s`);
for (const slug of [...new Set(rows.map((r) => r.slug))]) {
  const rs = rows.filter((r) => r.slug === slug);
  console.log(`  ${slug}: ${rs.filter((r) => r.ok).length}/${rs.length} answered, ${rs.filter((r) => r.citationHit).length}/${rs.length} citation hits`);
}
console.log(`answers saved to: ${ANSWERS_MD}`);
console.log(`results saved to: ${RESULTS_JSON}`);
