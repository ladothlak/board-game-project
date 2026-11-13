# Chat Answer Latency Plan

A focused plan for cutting the wall-clock lag between a player clicking **Ask** on a
game page and the final answer appearing. This complements `PERFORMANCE-PLAN.md`
(Tiers 1–4 done) and targets only the `/api/chat` request path.

**Scope (2026-11-12):** Tiers 1 and 2 are in scope. Tier 3 (faster chat model) is
deferred — it's an infra decision, not a code one, and is revisited only if the
Tiers 1–2 work leaves a generation floor that still hurts.

```
click "Ask" ──▶ prewarm cache? ─▶ RAG (expand → retrieve → re-rank) ─▶ generation (streamed)
                  │ miss            │ up to 30 s LLM      │ up to 30 s LLM   │ up to 60 s, max_tokens 2000
                  ▼                 ▼                       ▼                ▼
              instant          ~ms (BM25)                    └── all serialized on the single-flight
                                                               LLM queue (lib/llm-queue.ts)
```

**Measured baseline** (from `PERFORMANCE-PLAN.md` §4, 32-case live benchmark):

| Path | Mean end-to-end |
| --- | --- |
| Existing pipeline (keyword + LLM expand + LLM re-rank) | ~37.7 s |
| Decision-model pipeline (`USE_DECISION_MODEL=1`, opt-in, default **off**) | ~8.8 s |

The generation call dominates: a 27B reasoning model burning hundreds of thinking
tokens before the first streamed character, with `max_tokens: 2000` and a 60 s
timeout (`app/api/chat/route.ts`). Everything before it — expansion (up to 30 s)
and re-rank (up to 30 s) — is paid only when the prewarm cache misses *and* the
skip gates don't fire, and all of it queues behind whatever else holds the
single-flight LLM slot.

**What does not exist yet** (each is a lever below):

- No per-stage timing — `logRequest` records total `durationMs` only
  (`lib/audit-log.ts`).
- No answer cache — only the 60 s prewarm *context* cache
  (`app/api/chat/prewarm/route.ts`).
- No progress feedback — the SSE stream starts after RAG completes; the user
  sees "Brewing an answer…" until the first token arrives
  (`components/chat-bar.tsx`).

---

## Tier 0 — Measure (do first; everything below is unverifiable without this)

**Where:** `app/api/chat/route.ts`, `lib/audit-log.ts`.

**What to do:**

- Record per-stage durations on the chat route: `expandMs`, `retrieveMs`,
  `rerankMs`, `prewarmHit` (bool), `firstTokenMs` (time from request start to
  first streamed token), and keep `durationMs` for total. Extend `AuditEntry`
  with a `stages?: Record<string, number>` field; write it into the existing
  JSONL line.
- Have `buildRagContext` return its stage timings (it already knows when each
  step started/ended internally — thread a small `timings` object out alongside
  `RagContext`).
- Re-run the live benchmark (`lib/__tests__/rag-benchmark.test.ts`,
  `RUN_LIVE_BENCH=1`) after each tier lands so every change shows up in the same
  table as the §4 numbers.

**Expected:** a per-question latency breakdown in `logs/audit.log` that makes
each win below measurable instead of anecdotal.

---

## Tier 1 — Biggest wins

### 1.1 Answer cache: repeat questions become instant

**Where:** `app/api/chat/route.ts` (new module-level cache, mirroring the
prewarm cache pattern in `app/api/chat/prewarm/route.ts`).

**Why:** A personal site asks the same rule questions repeatedly ("How do I
set up the game?", "What happens when an Intruder appears…"). Today every one
of those re-runs the whole pipeline — tens of seconds for a finished answer.

**What to do:**

- Cache the *final answer* (not just the RAG context) keyed by
  `slug::normalized-question`, storing `{ answer, citations, ts }`.
- TTL ~24 h, cap ~100 entries (answers are small; a few hundred KB max).
- Invalidate on index change: key the cache generation off the same mtime
  `loadIndex()` already tracks (`lib/retrieve.ts`) so a re-digested rulebook
  can't serve stale answers.
- On hit: skip RAG and generation entirely; replay the cached answer through
  the existing SSE protocol (one `token` event + `done` with citations).

**Expected:** repeat questions drop from ~10–40 s to < 50 ms. Zero model cost.

### 1.2 Retrieve-first: stop paying for expansion when retrieval already won

**Where:** `lib/rag.ts` (`buildRagContext`).

**Why:** `expandQuery` is a full LLM round trip (up to 30 s) that runs *before*
retrieval, even though BM25 base retrieval on the original question alone is
fast (~ms) and already passes the quality gate for many questions. The current
order — expand → retrieve → maybe re-rank — pays the expansion cost up front
for questions that never needed it.

**What to do:**

1. Run `multiQueryRetrieve` on the **original question first** (no expansion).
2. Fire `expandQuery` concurrently in the background.
3. If the base result passes the existing quality gate (top score ≥ 3, ≥ 2×
   runner-up, top chunk contains ≥ 2 distinct query terms — the same test that
   already skips re-rank at lines ~795–802), proceed to re-rank/generation
   **without awaiting** the expansion; let the background call finish into the
   void.
4. Only when the base result is weak, `await` the expansion and merge via
   `multiQueryRetrieve` as today.

**Expected:** easy-to-medium questions skip up to 30 s of pre-generation
latency; hard questions pay no more than today. Risk: paraphrased questions
that base retrieval misses — mitigated by step 4 (expansion still runs, it just
no longer blocks the easy path) and verified against the 32-case benchmark.

### 1.3 Re-evaluate the decision-model pipeline before making it the default

**Where:** `lib/__tests__/rag-benchmark.test.ts`, `PERFORMANCE-PLAN.md` §4,
`.env`.

**Why:** The §4.1 benchmark that motivated this item (~8.8 s vs ~37.7 s
end-to-end; MRR 58.2% vs 70.9%) **predates two structural changes**: BM25
becoming the default lexical scoring (issue #51) and the selection-stage
tuning (issue #53 — `followCrossRefs` slice 6→8, `adaptiveContext` floor
200→100). Its retrieval-quality numbers were measured against the old TF-IDF
pipeline, so the quality side of the trade-off is stale and must be re-measured
at length. The latency side (a ~1.5–6 s batched `score` call vs an LLM re-rank
that can take 30 s) is structural and unlikely to have moved, but both arms
need fresh numbers before any default flip.

**State of the code (no new harness work needed):**

- Both benchmark arms run through `buildRagContext`, so they automatically pick
  up the current defaults (BM25 scoring, tuned selection) — re-running the
  live benchmark measures the *current* pipeline in both modes.
- The §4.1 follow-up — skipping the re-rank when the quality gate already fires
  (clear lexical winner) — is already integrated in `buildRagContext` and
  applies to both modes.

**What to do — the re-evaluation, in order:**

1. **Re-run the live benchmark** (`RUN_LIVE_BENCH=1`) over all 32 labelled
   cases: both arms, per-case table plus aggregates (in-context, in-excerpts,
   MRR over `rankedPages`, recall@3, mean latency). Record the fresh numbers in
   `PERFORMANCE-PLAN.md` §4 alongside the stale ones so the delta is visible.
2. **Repeat at least 2–3 times.** §4.1 documents that LLM expansion variants are
   load-dependent and differ run-to-run; a single run is not enough evidence to
   flip a default.
3. **Evaluate a third, hybrid configuration:** decision model by default with
   fallback to the full LLM pipeline when `estimateConfidence` is low (e.g.
   < 0.25). This keeps the latency win on easy questions while retaining the
   reasoning model for the hard questions it has historically won. The benchmark
   harness can run this as a fourth arm since all arms share `buildRagContext`.
4. **Pre-commit decision criteria** so the evaluation can't rationalize any
   result:
   - Flip the global default only if mean latency improves ≥ 50% **and**
     in-context hit rate regresses ≤ 2 points **and** existing-only divergence
     cases are ≤ 1.
   - Otherwise adopt hybrid routing if it meets the same quality bar with a
     meaningful latency gain; if not, keep `USE_DECISION_MODEL` opt-in and
     revisit after 1.2 and 1.4 land (they change which questions reach the
     re-rank at all, which changes what this decision is even about).
5. Whichever arm wins, keep the env override so A/B benchmarking stays clean
   going forward.

**Sequencing note:** run this *after* 1.2 (retrieve-first) lands — 1.2 changes
the candidate pool both arms score, so evaluating the decision model against
the pre-1.2 pipeline would measure a state that no longer exists.

**Expected:** a defensible, current-state answer to "is the decision model good
enough to be the default?" If yes: typical first-time question drops from ~37 s
to ~9 s. If no: a hybrid that captures most of the latency win without the
ranking regression — or a documented decision to keep the status quo and invest
in base retrieval instead.

### 1.4 Prewarm must never block the real question

**Where:** `app/api/chat/prewarm/route.ts`, `lib/rag.ts`, `lib/llm-queue.ts`.

**Why:** Prewarm runs the *full* RAG pipeline — including LLM expansion and
re-rank — on the **same single-flight queue** as generation. A prewarm in
flight when the user hits "Ask" means their question waits behind a
speculative request for context they may never use. Prewarm can also start a
second, duplicate RAG build for the same question the chat route is about to
run (no deduplication exists).

**What to do:**

- Give prewarm a **fast path only**: deterministic expansion
  (`expandQueryDeterministic`, already in `lib/rag.ts`) + the skip-rerank gate,
  so it never touches the main model's queue. Its job is to be *cheap and fast*,
  not perfect — the chat route remains the quality bar.
- Deduplicate: track in-flight prewarm promises by key; if `/api/chat` arrives
  for a question with an in-flight prewarm, `await` that promise instead of
  building a second context.

**Expected:** prewarm stops stealing generation time; duplicate RAG builds
eliminated; prewarm hit rate unchanged (the fast path is what the cache stores).

---

## Tier 2 — Perceived latency

### 2.1 Stage events: show progress before the first token

**Where:** `app/api/chat/route.ts` (SSE protocol), `components/chat-bar.tsx`.

**Why:** The first visible feedback today is the first generated token, which
arrives after RAG + the model's thinking phase — often 10–40 s of "Brewing an
answer…". The user can't tell whether it's working or hung.

**What to do:**

- Extend the SSE protocol with `{ type: "stage", stage: "retrieving" }` sent
  immediately when the request starts (before RAG) and
  `{ type: "stage", stage: "pages-found", pages: number[] }` right after
  `buildRagContext` returns (the `pages` field is already in `RagContext`).
- In `chat-bar.tsx`, render a lightweight stage line ("Found pp. 3, 7 —
  brewing…") while `loading && !hasAssistantContent`. No new dependencies;
  the existing "Still brewing…" state at 15 s stays as the fallback.

**Expected:** first visible feedback drops from ~10–40 s to < 1 s. The answer
still takes the same real time, but perceived lag is a large fraction of the
complaint — this is the cheapest win in the plan.

### 2.2 Trim the generation prompt (prefill cost)

**Where:** `app/api/chat/route.ts`, `lib/rag.ts`.

**Why:** The system prompt carries the TOC **twice** — `hierarchicalToc`
(section groups) *and* the flat one-line-per-page `pageMap` (~100 lines for a
100-page rulebook) — plus ~4000 chars of excerpts and up to 6 history
messages. Every prefill token is seconds of decode on a 27B model before the
first output token.

**What to do:**

- Drop the flat page map when the hierarchical TOC already covers the pages
  (it groups every chunk's page), or cap it; keep whichever is shorter.
- Scale `max_tokens` with question type: explicit-page questions
  (`detectExplicitPages` non-empty) get a smaller budget — the answer is
  in-context and needs less thinking. Investigate whether the Unsloth endpoint
  exposes a reasoning-effort knob; if so, use low effort for
  classification=`setup`/`turn-structure` questions.
- Measure prefill vs decode split via the Tier 0 `firstTokenMs` timing before and
  after; only keep changes that move it.

**Expected:** a few seconds off every generation; largest on long rulebooks.

### 2.3 Client prewarm tuning

**Where:** `components/chat-bar.tsx`.

**Why:** The 800 ms debounce + full-pipeline prewarm means the cache is only
warm if the user pauses long enough for a ~10–40 s build to finish before
clicking Ask — rare in practice.

**What to do:**

- With Tier 1.4's fast path, prewarm completes in well under a second, so lower
  the debounce to ~400 ms and fire on ≥ 15 chars (already aligned with the
  server threshold). The cache now warms reliably within normal typing pace.
- Optional stretch: when a prewarm *hit* exists and the LLM queue is free,
  speculatively start generation before "Ask" is pressed. High token cost for a
  personal site — only worth it if 1.1's answer cache proves repeat questions
  are rare.

**Expected:** prewarm hit rate rises from "lucky typing pace" to the norm.

---

## Tier 3 — Strategic (deployment-level)

### 3.1 Serve a faster model for generation

**Where:** deployment (`unsloth run`), `app/api/chat/route.ts`, `.env`.

**Why:** Generation is the dominant cost and it's structural: a 27B reasoning
model thinking for hundreds of tokens per answer. No prompt or pipeline change
removes that floor.

**What to do:**

- Run a second, faster model alongside the 27B (Unsloth serves multiple models;
  e.g. a non-reasoning instruct model or a smaller quantization) and point
  `UNSLOTH_MODEL`/`UNSLOTH_BASE_URL` for chat at it, keeping the 27B for the
  benchmark suite and hard-question fallback.
- Gate per question: route simple/classified questions to the fast model,
  keep the reasoning model for low-confidence retrieval
  (`estimateConfidence < 0.25`) and comparison questions.

**Expected:** the largest remaining win — potentially 5–10× on generation time.
Costs real infrastructure (GPU memory for two models) and needs its own A/B on
answer quality, so it is deliberately last.

---

## Risks & trade-offs

- **1.2 (retrieve-first)** trades a little retrieval recall on paraphrased
  questions for big latency savings. The "expand if weak" fallback preserves
  today's behavior in the worst case; verify with the 32-case live benchmark
  before and after.
- **1.3 (decision model re-evaluation)** — the stale §4.1 numbers (MRR 70.9% →
  58.2%, in-context 93.8% → 90.6%) predate BM25-default and the selection
  tuning, so they no longer describe the trade-off. The re-evaluation's
  pre-committed criteria (see 1.3) bound the downside: no default flip without
  fresh numbers meeting the quality bar, and the hybrid fallback exists
  specifically for the "fast on easy questions, reasoning model on hard ones"
  outcome.
- **1.1 (answer cache)** can serve stale answers if a rulebook is re-digested —
  handled by mtime-keyed invalidation; the 24 h TTL bounds staleness for
  unchanged indexes.
- **2.2 (prompt trim)** risks degrading answer quality if the TOC/excerpts
  carry weight the benchmark didn't isolate — measure `firstTokenMs` *and*
  spot-check answers, not just speed.

## Suggested order

1. **Tier 0** measurement — half a day; makes everything below verifiable.
2. **1.1 answer cache** — smallest change, instant win on repeats, zero model cost.
3. **2.1 stage events** — one afternoon, big perceived-latency win.
4. **1.2 retrieve-first** — the structural RAG win; benchmark-gated.
5. **1.3 decision-model re-evaluation** — run *after* 1.2 (it changes the
   candidate pool both arms score); outcome is one of: flip default, adopt
   hybrid routing, or keep opt-in with a documented reason.
6. **1.4 prewarm fast path** — independent of 1.3's outcome; lands either way.
7. **2.2 prompt trim + 2.3 prewarm tuning** — polish, measured per item.

Tier 3 (faster chat model) is deferred out of scope; revisit only if the
Tiers 1–2 work leaves a generation floor that still hurts.

Each tier is independently shippable and reversible via env flags; nothing in
Tier 2+ blocks Tier 1.
