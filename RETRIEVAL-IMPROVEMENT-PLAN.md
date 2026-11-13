# Retrieval Improvement Plan

Addresses point 3 from `PERFORMANCE-PLAN.md` §Tier 4: **both pipelines miss 17 of 32
benchmark questions at the base-retrieval level, regardless of which re-ranker runs.**
This plan diagnoses *where* those misses happen and prioritizes fixes by evidence.

## Diagnosis (grounded in diagnostics, 2026-11-12)

Two throwaway diagnostics produced the evidence:

- `lib/__tests__/_diag-bm25.test.ts` — deterministic comparison of production TF-IDF
  vs BM25 on the 17 missed cases + 4 control hits (raw top-8 stage).
- `lib/__tests__/_diag-retrieval.test.ts` — live trace of each missed case through
  raw TF-IDF → LLM expansion → merged pool → final context.

### F1: The benchmark's effectiveness metric measures the wrong thing

`buildRagContext` returns `pages` sorted by **page number**, not relevance
(`lib/rag.ts:733`: `.sort((a, b) => a - b)`). The benchmark computes MRR and
recall@3 over that ordering as if it were a relevance ranking. An answer page that
**is in the final context** but has a high page number is counted as a miss.

Evidence (full 17-case trace): in **all 17 cases the expected page's text is
present in the injected `excerpts`** — the answer document already reaches the LLM
in every "missed" case. Example — "What happens when I plow a field?" (expected
p. 6): final context `[4,5,6,7,8,9,10,11]`, p. 6 present and in the excerpts; the
benchmark still scores it poorly because MRR/recall@3 are computed over the
page-number ordering, where the answer's *relevance* rank (top of the candidate
pool) is invisible.

The one partial case: Catan "How does trading work?" (expected p. 11 **and** 14)
gets only p. 14 into the context/excerpts — p. 11 is absent.

**Implication:** the "17/32 miss" headline is a metric artifact, not a retrieval
failure. True end-to-end effectiveness on this subset is 16 full + 1 partial out of
17. The benchmark must be fixed before any other work, or every subsequent
measurement is built on sand.

### F2: True retrieval misses are rare

Raw top-8 stage, 21 cases (17 missed + 4 control hits):

| Scorer | Answer page in top-3 |
| --- | --- |
| Production TF-IDF | 18/21 |
| BM25 (k1=1.2, b=0.75) | **19/21** |
| BM25 + phrase bonuses | 18/21 |

Only **one** case has the answer page absent from the top-8 entirely: Catan
"How does trading work in Catan?" (expected p. 11/14; top-8 = `[2,10,7,9,16,5,4,6]`).
BM25 pulls p. 14 into rank 2 there. BM25 also fixes "fight an Intruder" (rank 4→2)
and the Nemesis setup control (rank 4→1), at the cost of two regressions
(Agricola solo 1→4, Catan goal 1→4). Net: +1 case, and it is deterministic with zero
latency cost.

### F3: Query expansion is unstable under load

In the full 17-case trace, expansion produced genuine variants
(e.g. `"solo player"`, `"trade offer"`, `"resolve turmoil"`), and the merged pool
ranked the answer page higher than raw TF-IDF in most cases (e.g. Catan goal:
raw rank 1 → merged rank 4 is a regression, but trading: absent → rank 7). In an
earlier partial run under LLM contention, however, the expansion returned the
question echoed verbatim and added zero signal. The behavior is load-dependent —
when the 27B model is slow or times out, `expandQuery` falls back to the original
question, silently degrading multi-query retrieval.

**Implication:** expansion needs a deterministic fallback (n-grams + per-game
synonym map) so multi-query retrieval keeps working when the LLM is unavailable
or echoes.

### F4: The selection stage caps the final set

`followCrossRefs(candidates.slice(0, 6))` limits the final page set to top-6 +
cross-ref pages; `adaptiveContext` then allocates a 4000-char budget proportionally
to score with a 200-char floor per chunk. Any answer page ranking 7th or lower in
the merged pool is dropped from the context entirely, and low-relevance chunks can
consume budget that the answer chunk needs.

## Prioritized actions

### P0 — Fix the benchmark metric (hours)

- Expose relevance-ordered pages from `buildRagContext`: add `rankedPages: number[]`
  (candidate order before the page-number sort) alongside the existing `pages`.
- Report three effectiveness metrics instead of one:
  1. **in-context hit rate** — expected page present in `pages`;
  2. **in-excerpts hit rate** — expected page's text present in `excerpts` (the true
     end-to-end signal: did the answer actually reach the LLM?);
  3. **MRR over `rankedPages`** — relevance-ordered, not page-number-ordered.
- Re-baseline all 32 cases. Expect the "17/32 miss" number to drop substantially.

### P1a — BM25 scoring in `lib/retrieve.ts` (half day)

Replace TF-IDF term weighting with BM25 (k1=1.2, b=0.75), keeping the same idf shape
and function signatures. Evidence: fixes the only true retrieval miss (trading),
+1 net top-3 on 21 cases, no control-hit regression. Deterministic; zero latency
cost. A/B via the benchmark before/after; keep TF-IDF behind a flag until the
benchmark confirms.

### P1b — Make query expansion robust (half day)

Expansion degrades to a verbatim echo when the LLM is slow or times out (observed
under load), which silently disables multi-query retrieval. Options:

- Prompt fix: force distinct variants ("Do NOT repeat the original question; use
  rulebook terminology for this game").
- Deterministic fallback: when the LLM returns an echo (or times out), expand with
  query n-grams + a small per-game synonym map (e.g. "plow" → "Plow 1 field",
  "solo" → "Solo version").

This helps **both** pipelines and keeps the multi-query merge meaningful under load.

### P2 — Selection-stage tuning (half day)

- Raise `followCrossRefs`'s input from `slice(0, 6)` to `slice(0, 8)` so the final
  set matches the candidate pool size.
- Revisit `adaptiveContext`'s 200-char floor: a low-score chunk's guaranteed 200
  chars can crowd out the answer chunk. Consider dropping the floor or making it
  score-relative.

### P3 — Hybrid dense retrieval (larger; deferred)

Embedding index + hybrid lexical/dense scoring. Only worth it after P0–P2 show the
ceiling; requires an embedding model and `scripts/build-index.mjs` changes.

## Validation protocol

- The 32-case dataset is the regression suite; run the live benchmark
  (`RUN_LIVE_BENCH=1 npx vitest run lib/__tests__/rag-benchmark.test.ts`) before
  and after each change.
- Report per change: in-context hit rate, in-excerpts hit rate, MRR (relevance
  order), recall@3, mean latency.
- Gate: no change ships if it regresses any aggregate effectiveness metric without
  a compensating latency win.

## Open questions

- ~~Will the `inExcerpts` column confirm F1's artifact accounts for most of the 17
  misses?~~ **Answered (2026-11-12, full trace):** yes — all 17 cases have the
  expected page's text in the excerpts (16 full + 1 partial: Catan trading gets
  p. 14 but not p. 11). The "17/32 miss" is a metric artifact.
- Do the two BM25 regressions (Agricola solo, Catan goal) persist after P1b, or does
  better expansion restore them?
