# RAG Pipeline Improvement Plan — Accuracy First

**Status:** Proposed · 2026-11-13
**Inputs reviewed:** `RAG-PIPELINE-SUMMARY.md`, `lib/rag.ts`, `lib/retrieve.ts`, `lib/extract-pdf.mjs`, `scripts/build-index.mjs`, `scripts/grade-retrieval.ts`, `app/api/chat/route.ts`, `app/api/chat/prewarm/route.ts`, `lib/__tests__/rag-benchmark.test.ts`, plus offline diagnostics over the real `public/search-index.json` (561 pages / 34 games).
**Priority rule:** accuracy first. Every change must be justified by answer visibility or answer correctness. Latency is a constraint, not the objective: target retrieval p95 ≤ 1.5 s and time-to-first-token p95 ≤ 3 s, but do not buy speed by lowering retrieval quality.

---

## 1. Verdict

The pipeline has good bones — a deterministic benchmark, bounded context, page-level citations, stage timing, and a clear prompt contract. But **the documented 76.7% hit rate substantially overstates what the LLM actually sees**, and several stages actively inject wrong pages or delete correct text after retrieval has succeeded.

The highest-leverage problems are not "BM25 needs tuning." They are:

1. **The grader measures page membership before context assembly.** 21 of 100 expected pages never appear in the excerpts; 18 of the 66 "passing" cases have the expected page reduced to under 600 chars (some to 3–10% of the page). See §2.1.
2. **Context assembly deletes answer sentences.** `adaptiveContext` keeps only sentences containing query terms and cannot redistribute unused budget. Average context is 4,659 chars against an 8,000-char budget — 42% wasted — while answers are being truncated. See §2.2.
3. **The "section boost" is a hard rank override that no reranker can correct.** It assigns score 80/100, dominates confidence, skips the rerank gate, and crowds the real answer out of the budget. In a replica of the base+boost stages it fired on 61/86 cases; in 18 it injected only wrong pages. See §2.3.
4. **Section assignment is not structure-aware.** It regex-matches the first 200 chars of running text; 233/561 pages (42%) fall into `Other` and can never be boosted. For Betrayal, 50/68 pages are `Other` because every page begins with print-shop boilerplate. See §2.4.
5. **Data extraction is damaging the corpus.** PDF extraction joins text items with spaces and discards layout, fonts, columns, and reading order. 66 pages start with print boilerplate and 54 start mid-word. No retrieval fix can fully compensate. See §2.5.
6. **The prewarm fast path replaces the quality path for real users.** Chat serves prewarmed contexts built with `skipRerank`, deterministic expansion, and keyword classification. Any accuracy improvement to the main path is bypassed for questions typed with a pause. See §2.6.
7. **Hard queries are structurally gated away from expansion.** `needsExpansion` requires `question.length > 20`; "How do I win?" (12 chars) never expands. Azul and Coup return *zero* pages for that exact question. See §2.7.

---

## 2. Evidence (measured, not inferred)

### 2.1 The headline metric is an upper bound, not answer visibility

Offline run of the exact deterministic grade configuration (86 cases):

| Measurement | Result |
|---|---|
| Grade pass (all expected pages in `pages`) | 66/86 (76.7%) |
| Expected pages absent from `excerpts` | **21/100 (21%)** |
| Grade-passing cases whose expected excerpt is **< 600 chars** | **18/66 (27%)** |
| Expected pages delivered at >90% of original text | 36/100 |
| Average excerpt size / configured budget | **4,659 / 8,000 chars (58%)** |
| Average selected pages | 6.8 |

Examples:

- Castles of Burgundy, "How do I set up the game?", expected p.5: **139 of 4,088 chars delivered (3%)**, yet the case is marked ✓.
- Flash Point, "How do I set up the game?", p.3: 98 of 2,891 chars (3%), marked ✓.
- Carcassonne, "How do I win?", p.4: 193 of 3,400 chars (6%), marked ✓.

`grade-retrieval.ts` checks `result.pages` (candidate membership), not `result.excerpts`. Pages that rank last are dropped by the budget but still counted. The grade script must report delivered text, and `buildRagContext` should expose `excerptedPages` so callers can distinguish "selected" from "visible."

### 2.2 Context assembly loses the answer and wastes the budget

`adaptiveContext` → `extractRelevantSentences`:

- Drops every sentence with zero query-term overlap. A setup instruction that does not literally contain "set", "game", or "how" is discarded even if it is the answer.
- Applies the per-page allocation independently; unused allocation from a sparse page is **not** redistributed.
- Breaks when `used >= budget`, leaving later pages unrepresented — but `pages` still includes them.

This is why the average context uses only 58% of the budget while expected pages are truncated. Raising `RAG_CONTEXT_BUDGET` (as the summary proposes as a design win) will not fix this; it will just add more irrelevant text.

### 2.3 Section boost is an override, not a prior

`boostSectionPages` assigns score 80 (explicit pages: 100). Consequences:

- **Rerank cannot correct it.** Both rerank paths score `combined = lexical * 1 + reranker * 3`. A boosted page at 80 vs. lexical pages around 3–10: the reranker's maximum 12 cannot reorder it. The LLM/decision model is structurally powerless on exactly the queries where it is most needed.
- **The quality gate is satisfied by the boost itself.** In a replica of the base + boost stages, `passesQualityGate` passed on 5/86 cases before the boost and 15/86 after it. Those queries skip reranking entirely.
- **Confidence saturates.** `estimateConfidence` is `min(1, topScore / 10)`. With a boost of 80–100, confidence is exactly 1.0 in **60/86 cases (70%)**. The low-confidence prompt note and hybrid fallback therefore almost never fire for setup/victory/turn questions.
- **A wrong boost crowds out the right page.** Boosted chunks receive a proportional share of the budget; if the boosted page is wrong, the correct lexical winner gets a minimum slice. 18/86 cases had section pages injected with no expected page among them.

### 2.4 Section assignment is unreliable at the data level

`SECTION_PATTERNS` test a regex against the first 200 chars of flattened page text, and `findSectionPages` uses first-match-wins. Measured assignment across all 561 pages:

| Section | Pages |
|---|---|
| Other | **233 (42%)** |
| Game Structure / Turn Order | 82 |
| Core Rules | 74 |
| Setup | 49 |
| Victory / End of Game | 43 |
| Introduction / Overview | 26 |
| Reference / Quick Play | 22 |
| Special Abilities / Keywords | 20 |
| Combat / Conflict | 12 |

Examples:

- Anachrony p.10 (expected victory) begins with "action" → assigned **Core Rules**; victory boost injects p.11 and p.15, never p.10.
- Azul p.3 ("Object of the game … most points … after the round") → **Game Structure** because "round" matches before the victory pattern.
- Betrayal: 50/68 pages are `Other` because every page starts with `12" x 9" flat sheet folded to 6" x 9" 4C2S`. The regex sees boilerplate, not headings.

`hierarchicalToc` is built from the same assignments, so the LLM's table of contents is also wrong. Since the model is told to use the TOC to cite pages, this actively invites incorrect citations.

### 2.5 PDF extraction is the root cause for several failures

`lib/extract-pdf.mjs` does `tc.items.map(item => item.str).join(" ")` and discards:

- line and column geometry,
- font size/weight (the only reliable heading signal),
- reading order on multi-column and two-page spreads,
- the PDF outline.

Corpus symptoms:

- 66 pages begin with print-shop boilerplate;
- 54 pages begin mid-word (e.g. Betrayal: "he wall in front of you…", "opy lengths of muscled tissue…");
- repeated headers/footers and page furniture become part of the searchable text;
- headings are not distinguished from body copy.

Betrayal's 3/4 failures are primarily this, not "section patterns struggle at scale."

### 2.6 The prewarm path bypasses the quality path

`app/api/chat/prewarm/route.ts` builds contexts with:

```ts
{ useDecisionModel: false, expansionMode: "deterministic", skipRerank: true }
```

`app/api/chat/route.ts` returns that context verbatim on a prewarm hit. Prewarm fires after a 400 ms typing pause for questions ≥15 chars. In normal use, the answer is therefore generated from the **least accurate** pipeline configuration — no rerank, deterministic expansion, keyword classification. The summary's quality claims do not apply to that path.

### 2.7 Expansion is gated off for the hardest short queries

```ts
const baseNeedsExpansion = question.length > 20 && explicitPages.length === 0;
```

"How do I win?" is 12 chars → no expansion, ever. Azul has no token `win` anywhere in its 6 pages (it says "most points… the game ends…"), so retrieval returns **zero candidates** and the user gets an empty context. Coup has the same issue ("Objective: be the last player standing", no "win"). Short queries are the *most* likely to need rewriting, not the least.

### 2.8 Analyzer quality is far below what the corpus supports

`tokenize()` only lowercases, splits on non-alphanumerics, and drops words ≤2 chars. There is:

- no stopword list ("how", "the", "do" contribute weight),
- no stemming/lemmatization (win / winner / winning / won are four unrelated tokens),
- no synonym or domain lexicon (setup / set up; score / scoring / VP; draw / drawing / drawn),
- no typo tolerance or character n-grams,
- no phrase-aware heading index.

A prototype analyzer (stopwords + light stemming/canonicalization + standard BM25 IDF floor at 0) on the same 86 cases, raw top-8 with no boosts or expansion:

| Scorer | Top-8 hit | MRR |
|---|---|---|
| Current BM25 | 69/86 (80.2%) | 0.472 |
| Stopwords + stem + canonicalization + IDF floor | **73/86 (84.9%)** | **0.560** |

That is +19% relative MRR from a deterministic change with no model cost. It still leaves 13 cases where the answer is absent from top-8, which is why hybrid retrieval is required later.

### 2.9 Evaluation coverage and documentation do not match the code

- The summary says "86 cases across all 34 indexed games." The grade script covers **29 game slugs**; five indexed games are not graded at all: `agricola`, `catan`, `container`, `nemesis-lockdown`, `root`.
- The summary says the benchmark dataset has 86 labelled cases. `rag-benchmark.test.ts` contains **118**.
- The summary's 76.7% (deterministic, keyword classification, no rerank) is not comparable to `PERFORMANCE-PLAN.md`'s 96.9% (live, decision model, 32-case set). Both are presented as "retrieval quality" without their configuration.
- `npm run grade` exits 1 by design, so it is not a regression gate.
- No case tests an unanswerable question, a follow-up, a scanned PDF, an expansion, or citation validity. The suite cannot detect the most dangerous failure mode: confidently answering from weak context.
- The summary claims "34 games (16 + 20 = 36 listed)." The list is internally inconsistent.

### 2.10 Multi-turn questions are not retrieved against

`buildRagContext` receives only the current question. The chat route passes history to the generation prompt but **not** to retrieval. "What about in summer?" or "And for two players?" is retrieved as a standalone fragment and returns noise. The code even has an empty `// ─── 9. Follow-Up Detection ───` section, indicating this was planned but never built.

### 2.11 Citations are prompt-enforced only

The TOC lists every page, including pages not loaded in the excerpts. The system prompt says not to guess page numbers, but there is no post-generation check that each `(p. N)` is in `excerptedPages`. In an accuracy-critical product, citation validity must be verified, not requested.

---

## 3. Target architecture

```
User question (+ history)
   │
   ├─ 1. Query understanding
   │     history-aware rewrite → standalone query
   │     intent/query type (LLM or decision model; keyword fallback)
   │     entity/section/page hints (soft, never overriding)
   │
   ├─ 2. Candidate generation (recall)
   │     BM25 over passage chunks
   │     + dense embeddings over passage chunks
   │     + heading/section index
   │     + explicit page / expansion boosts (bounded priors)
   │     → RRF fusion, top ~50 passages
   │
   ├─ 3. Rerank (precision)
   │     cross-encoder or LLM over full passages (top 20–30)
   │     features: lexical, dense, section prior, page adjacency
   │     → calibrated confidence + top pages
   │
   ├─ 4. Context assembly
   │     expand passages → full pages (citation unit)
   │     include adjacent page when a rule spans a spread
   │     rank sentences but keep neighbouring windows
   │     redistribute unused budget; label sections
   │
   ├─ 5. Generation
   │     excerpts first, TOC optional/secondary
   │     strict citation contract
   │
   └─ 6. Verification
         cited page ∈ excerpted pages? quote grounded?
         if not: repair once, or abstain with a clear message
```

Retrieval unit = passage chunk. Citation unit = page. Never conflate the two again.

---

## 4. Work plan

Effort assumes one developer familiar with the codebase. Calendar estimates are elapsed, not full-time.

### P0 — Stop the measurement and assembly bleed (2–3 days)

**Goal:** make the reported number truthful and recover accuracy that is being thrown away after retrieval.

| ID | Change | Files | Acceptance |
|---|---|---|---|
| P0.1 | Add `excerptedPages: number[]` and `excerptCoverage: Record<page, ratio>` to `RagContext`; derive from the actual `--- Page N ---` blocks. | `lib/rag.ts` | A returned page that is not in the excerpts is impossible by construction. |
| P0.2 | Rewrite `adaptiveContext`: (a) never drop all non-matching sentences — rank sentences but keep ±1 neighbour windows; (b) two-pass allocation that redistributes unused budget; (c) guarantee every selected page gets at least one contiguous window; (d) stop at the budget without claiming unrepresented pages. | `lib/rag.ts` | Average context ≥ 90% of budget; expected-page coverage ≥ 80% full text on grade hits; no regression in context precision. |
| P0.3 | Make section boosts bounded priors: cap at +10–20% over the top lexical score (or add as a rerank feature), never 80/100. Rerank boosted pages normally. Confidence must ignore boost magnitude. | `lib/rag.ts` | No case where a boost alone satisfies the quality gate; confidence no longer saturates on boosted queries; wrong-page injection cannot outrank a direct lexical hit. |
| P0.4 | Fix classification precedence and word boundaries. Move `victory` before `edge-case`; use `\b` boundaries; remove substring keywords ("if" in "difference", "turn" in "return", "vs" in "devs"). Add regression tests for the 39 observed misclassifications. Grade both keyword and decision-model classification. | `lib/rag.ts`, tests | Keyword accuracy ≥ 85% on the 118-case set; no precedence regressions. |
| P0.5 | Do not serve `skipRerank` prewarm contexts as final answers. Either (a) prewarm the full accurate pipeline in the background, or (b) cache only index/DF/query-embedding/candidate work and always finish rerank + assembly in `/api/chat`. Mark any fast context with `quality` and reject it for final use. | `app/api/chat/prewarm/route.ts`, `app/api/chat/route.ts` | A prewarm hit and a cold request produce identical excerpts for the same question. |
| P0.6 | Fix the expansion gate: fire when candidates are empty, when top score is low, or when the query has ≤2 content terms — not only when `length > 20`. AND the decision-model signal only after this rule, so the model can enable but not suppress a needed expansion. | `lib/rag.ts` | "How do I win?" on Azul/Coup returns non-empty candidates. |
| P0.7 | Validate citations after generation: every cited page must be in `excerptedPages`; if not, retry once with a strict reminder, then strip the invalid citation and flag the answer. Log the result. | `app/api/chat/route.ts` | Citation precision ≥ 99% on the eval set; invalid citations never reach the client silently. |

**Expected impact:** truthful baseline plus roughly +10–15 points of real answer visibility, with zero new model dependencies.

---

### P1 — Fix the corpus (3–5 days)

**Goal:** retrieval cannot be better than its text. This is the single largest accuracy lever for Betrayal-like rulebooks and for section anchoring.

| ID | Change | Details |
|---|---|---|
| P1.1 | Layout-aware PDF extraction | Use `pdfjs` text items' `transform`/font size: group into lines by Y, sort by X, detect columns, preserve paragraph breaks, repair hyphenation, drop repeated headers/footers by position and repeated-string frequency, use the PDF outline when present. Handle two-page spreads without losing the first character. |
| P1.2 | Heading and section index | Detect headings from font size/weight and line position; store `sectionPath` and `headings` per page. Replace the eight-regex/first-200-chars scheme with structural section detection; keep a regex fallback only when no heading is found. Allow multiple sections per page. |
| P1.3 | Passage chunking | Split pages into 300–600-token passages at paragraph/heading boundaries, 10–15% overlap, with `parentPage`, `sectionPath`, and token counts. Keep page-level output for citations. Index passages instead of whole pages. |
| P1.4 | Extraction health checks | Per page: starts mid-word? repeated boilerplate? no text? duplicated page? Report a health score during `npm run build:search`; fail the build for a game whose extraction is below threshold so bad data cannot silently enter the index. |
| P1.5 | Full OCR coverage | `ocrPdfPages` currently caps at `maxPages: 12`; detect scanned pages individually and OCR all of them (or document the limit and mark partial coverage). |

**Acceptance:**

- `Other` section share falls from 42% to < 15%.
- Betrayal: no page starts with print boilerplate; setup/combat/victory answers land in top-8.
- Every page has a non-empty section path or an explicit `unknown` flag.
- Index schema is versioned (`schemaVersion`, `analyzerVersion`, `embeddingModel`).

---

### P2 — Retrieval quality (6–9 days)

**Goal:** raise raw recall to the point where reranking and assembly can succeed.

| ID | Change | Rationale / evidence |
|---|---|---|
| P2.1 | Analyzer v2: stopwords, Snowball stemmer, domain canonicalization (`set up` → `setup`, `win/winner/winning/won` → `win`, `score/scoring/scored` → `score`, `draw/drawing/drawn`), number normalization, per-game glossary from metadata. Use standard BM25 IDF (floor at 0) instead of `+1`. | Prototype: +4 top-8 hits, MRR 0.472 → 0.560. Deterministic, zero model cost. |
| P2.2 | Hybrid dense retrieval over passage chunks. Precompute embeddings at build time; store vectors in the index (561 pages, so a few MB even at 384 dims). Fuse BM25 + dense with Reciprocal Rank Fusion, not raw score addition. Use a small English embedding model (e.g. bge-small/e5-small/gte-small) via ONNX or a local embedding endpoint. | Lexical misses are semantic: "win" vs "most points", "deck building" vs "acquire cards", typos, jargon. The corpus is tiny; this is cheap and high-value. |
| P2.3 | Cross-encoder or strong LLM rerank over top 20–30 passages, using full passage text. Keep a small local cross-encoder as the default; use the 27B model only for hard cases. Calibrate scores before fusion. | The current decision-model rerank sees only 200-char prefixes and only four candidates. Its MRR is lower than the slow LLM rerank (60.8% vs 72.4% in `PERFORMANCE-PLAN.md`). For accuracy-first, speed cannot be the deciding criterion. |
| P2.4 | History-aware query rewriting and expansion: rewrite the question into a standalone query using the last N turns; generate 2–4 search variants; optional HyDE (hypothetical answer passage) for hard/abstract questions. Fuse all variants with RRF; keep the original question highest-weighted. Deterministic fallback when the model is unavailable. | Fixes follow-ups and short queries. Expansion must be triggered by weak evidence, not length. |
| P2.5 | Convert section boost and expansion/page boosts from score overrides into **features**: small additive priors added after normalization, or inputs to the reranker. A user-explicit page reference can still be authoritative, but it should be the only hard override. | Removes the "reranker cannot fix a bad boost" failure mode. |
| P2.6 | Cross-reference following by section name as well as page number; follow "see Setup" / "see Combat" and resolve the section's pages. Include adjacent pages when a rule spans a spread. Bound the result and rerank additions. | Rulebooks commonly split a rule across facing pages (Anachrony p.10/11, Gloomhaven p.17/18). |

**Acceptance (dev set):**

- Raw recall@20 ≥ 95% (expected page present before rerank).
- In-excerpts all-expected hit ≥ 90%; full-coverage hit ≥ 80%.
- MRR over relevance order ≥ 0.75; recall@3 ≥ 0.85.
- Every "How do I win?" case returns a non-empty, relevant context, including Azul and Coup.
- No regression on the 66 currently passing cases; explicitly re-test all 20 failures.

---

### P3 — Answer-level accuracy and operations (3–5 days)

| ID | Change | Details |
|---|---|---|
| P3.1 | Answer-level eval | LLM-as-judge (with human calibration) on 60–100 questions: correct / faithful / complete / cites valid pages / appropriately abstains. Add 15–20 unanswerable questions and 10 follow-up conversations. Track separately from retrieval metrics. |
| P3.2 | Abstention path | If calibrated confidence is low after rerank, or citation validation fails twice, answer "the rulebook excerpts don't cover this" and name the closest sections. Do not let the TOC tempt a citation. |
| P3.3 | Prompt contract | Put excerpts before the TOC; label each block with page and section; instruct the model to quote/paraphrase only loaded text; require `(p. N)` citations and a one-line "source" list. Drop the TOC when its section accuracy is low. |
| P3.4 | Context budget | After P0.2, raise the budget to ~12–16k chars only if measured answer quality improves. Allocate by rerank relevance with a minimum per-page window; measure context precision, not just size. |
| P3.5 | Observability | Log per request: query type, rewritten query, candidate IDs/scores, boost events, rerank scores, excerpted pages, coverage, confidence components, citations, validation result, and timings. Sample failures for weekly review. Extend `RagTimings` with `embedMs` and `verifyMs`. |
| P3.6 | Cache correctness | Key the answer cache and prewarm cache on `schemaVersion + analyzerVersion + embeddingModel + indexMtime`; do not reuse a context built by an older pipeline. |
| P3.7 | Comparison mode | Give the second game the same passage retrieval, rerank, and budget as the primary game; today it uses raw top-3 lexical pages. |

---

### P4 — Speed (ongoing, after quality is stable)

The target budget, measured at p95 on the deployment machine:

| Stage | Target |
|---|---|
| Query rewrite (small model) | ≤ 300 ms, parallel with index load |
| BM25 over passages | ≤ 10 ms |
| Query embedding | ≤ 30 ms |
| Dense search (561 pages, in-memory) | ≤ 10 ms |
| Fusion | ≤ 5 ms |
| Cross-encoder over 25 passages | ≤ 800 ms CPU / ≤ 250 ms GPU |
| Context assembly | ≤ 20 ms |
| Retrieval total | **≤ 1.5 s p95** |
| Time to first token | **≤ 3 s p95** (generation dominates) |

Implementation notes:

- Precompute passage embeddings and BM25 statistics at build time; load once per index mtime; cache per slug.
- Run classification/rewrite and index load in parallel.
- Keep the decision model as a fast fallback, not the final arbiter on hard queries.
- Prewarm the accurate pipeline in the background during typing; if that is too expensive, prewarm only index/DF/query embedding/candidates and finish rerank in the request.
- Cache rerank results per (normalized query, index version) for repeated questions.
- Track p50/p95 per stage in the audit log; optimize only after P0–P2 stabilize.

---

## 5. Evaluation protocol

### 5.1 One canonical benchmark, three modes

| Mode | Purpose | Network |
|---|---|---|
| Deterministic CI | Fast regression gate for analyzers, boosts, assembly, and routing | none (mock decision model) |
| Production-config | The configuration users actually get (`USE_DECISION_MODEL` default, rerank enabled, prewarm-equivalent path) | local endpoints |
| Nightly live | Full answer-quality eval with LLM judge and citation verification | local endpoints |

Never report a single "hit rate" without naming the mode, the dataset, and whether it is page membership or excerpt delivery.

### 5.2 Metrics

| Metric | Definition | Target after P2 |
|---|---|---|
| Recall@20 (raw) | expected page present before rerank | ≥ 95% |
| In-excerpts hit | all expected pages' text present in `excerpts` | ≥ 90% |
| Full-coverage hit | expected pages delivered at ≥ 60% of original text | ≥ 80% |
| MRR (relevance order) | first expected page rank over `rankedPages` | ≥ 0.75 |
| Recall@3 (relevance order) | expected pages in top 3 | ≥ 0.85 |
| Context precision | fraction of excerpt chars from expected/reranked pages | ≥ 60% |
| Citation precision | cited pages that are in `excerptedPages` | ≥ 99% |
| Citation recall | expected pages cited when relevant | ≥ 80% |
| Answer correctness | judge: answer matches rulebook | ≥ 90% |
| Faithfulness | judge: every claim supported by excerpts | ≥ 95% |
| Abstention accuracy | correct "not covered" on unanswerable | ≥ 90% |
| Follow-up accuracy | correct answer with history | ≥ 85% |
| Retrieval p95 | stage timings | ≤ 1.5 s |

### 5.3 Dataset rules

- Merge the 118-case benchmark and the 86-case grade set; add the five indexed-but-ungraded games.
- Add 15–20 unanswerable questions (rules that do not exist, wrong game, ambiguous pronoun).
- Add 10 multi-turn conversations.
- Add at least one scanned/OCR rulebook and one expansion case.
- Split by **game**, not by question: at least 8 held-out games for the final test set. Never tune section patterns or synonyms against the test games.
- Keep a `known-failures.json` allowlist so `npm run grade` can become an actual CI gate instead of always exiting 1.

---

## 6. Sequencing

| Phase | Work | Effort | Dependency | Gate |
|---|---|---|---|---|
| P0 | Truthful metrics, context assembly, boost semantics, prewarm, expansion gate, citation validation, classifier fixes | 2–3 d | none | Baseline re-measured; no regression; actual excerpt hit reported |
| P1 | Layout extraction, headings, passage chunks, health checks, OCR | 3–5 d | P0 metrics | `Other` < 15%; Betrayal top-8 ≥ 3/4; index v2 |
| P2 | Analyzer v2, hybrid dense, rerank, rewriting, soft priors, cross-refs | 6–9 d | P1 chunks | Raw recall@20 ≥ 95%; MRR ≥ 0.75; failures re-tested |
| P3 | Answer eval, abstention, prompt, budget, observability, cache, comparison | 3–5 d | P2 | Correctness ≥ 90%; faithfulness ≥ 95%; citation precision ≥ 99% |
| P4 | Latency tuning and prewarm | ongoing | P2/P3 | Retrieval p95 ≤ 1.5 s; TTFT p95 ≤ 3 s |

**Total:** ~4–5 calendar weeks for one developer, with P0 shippable in a day or two.

---

## 7. Do not do

- **Do not raise `RAG_CONTEXT_BUDGET` before fixing P0.2.** More budget currently means more truncation and more noise, not more answers.
- **Do not add more section regexes or per-game pattern hacks.** That is how the current 42% `Other` rate happened. Fix extraction and use headings.
- **Do not tune to the 86 grade cases.** Split by game and keep a held-out set, or the next "improvement" will be a per-game special case.
- **Do not let a boost satisfy the quality gate or saturate confidence.** A prior is not evidence.
- **Do not let the prewarm fast path serve final answers.** It is currently the lowest-quality path in production.
- **Do not treat "in `pages`" as "the LLM saw it."** Measure delivered excerpts and coverage.
- **Do not optimize for a single aggregate number.** Report recall, MRR, coverage, citation precision, abstention, and latency together.

---

## 8. Corrections needed in `RAG-PIPELINE-SUMMARY.md`

| Location | Current claim | Correction |
|---|---|---|
| Overview / §Game Coverage | "34 indexed games" and "16 + 20" | Index has 34 slugs; the listed sets total 36. Grade covers 29. State the actual numbers. |
| §Benchmark Results | "86 deterministic cases across all 34 indexed games" | 86 grade cases across **29** games; 5 indexed games (`agricola`, `catan`, `container`, `nemesis-lockdown`, `root`) are ungraded. |
| §Test Suite | "Benchmark dataset … 86 labelled cases" | `rag-benchmark.test.ts` has **118** cases. |
| §Key Design Decisions | "Deterministic grading … zero network calls" | True, but it grades a configuration production never uses (keyword classification, no rerank). Label it a CI smoke test, not a quality bar. |
| §Benchmark Results | "Current hit rate: 66/86 (76.7%)" | Add: page membership only; 21/100 expected pages absent from excerpts; 18/66 passing cases have expected pages <600 chars. The end-to-end number is lower. |
| §Failure Analysis | Three categories (section misassignment, weak BM25, misclassification) | Add data extraction, context assembly/truncation, short-query expansion gate, and boost-override. The category counts are post-hoc, not measured. |
| §Pipeline Architecture | Classification order "victory before specific-rule" | Actual order is setup → turn-structure → edge-case → comparison → victory → specific-rule. `edge-case` before `victory` misclassifies "When does the game end?". |
| §Pipeline Architecture | "Returns a ranked candidate list (top ~10 chunks)" | Code retrieves top 8 and later slices to 8. |
| §Pipeline Architecture | Diagram omits prewarm, answer cache, history, and citation verification | Add them; they materially affect what users see. |
| §Key Design Decisions | "Section-anchored boost guarantees the structurally-correct page" | It cannot guarantee it: 42% of pages are unassigned, and the boost can inject wrong pages and override reranking. |
| §Key Design Decisions | "Anti-guessing guardrail" | It is prompt-only. Add post-generation citation validation; otherwise unloaded pages can still be cited. |
| §Grade description | "Exit 1 (documents gaps)" | An always-failing script is not a gate. Use a baseline snapshot/known-failures allowlist or fix the failures. |

---

## 9. First ten concrete tasks

1. Add `excerptedPages` + coverage to `RagContext`; update `grade-retrieval.ts` to pass only on delivered text.
2. Rewrite `adaptiveContext` to preserve sentence windows and redistribute unused budget; re-baseline.
3. Replace 80/100 boost scores with bounded priors; remove boost-driven confidence saturation.
4. Fix `classifyQuery` ordering and word boundaries; add the 39 misclassification cases as tests.
5. Change the expansion trigger to evidence-based (empty/weak/short-content), not `length > 20`.
6. Make prewarm stop serving `skipRerank` context as final; add a parity test.
7. Add post-generation citation validation with one repair attempt.
8. Build layout-aware extraction and a page-health report; fix Betrayal first.
9. Add heading/section metadata and passage chunks to the index (schema v2).
10. Ship analyzer v2 (stopwords + stemming + canonicalization + IDF floor) behind an A/B flag; validate the +4-hit/MRR improvement end-to-end.
