# Performance Improvement Plan

A prioritized plan for making the site faster and lighter. Findings are based on a
code review of the current build (`.next` chunk sizes, component imports, server
routes). Each item lists **where**, **why it matters**, and **what to do**.

**Status (2026-11-11):** All of Tiers 1 and 2 plus all of Tier 3 (3.1–3.6) done.
Notes on completed items:

- **1.1** — viewer renders only the visible window ± buffer at display resolution
  × devicePixelRatio (capped at 2); offsets precomputed from page geometry so
  scroll/TOC/jumps work before any page is rasterized.
- **1.2** — react-markdown stack moved to `components/chat-markdown.tsx`,
  lazy-loaded only when an assistant message exists.
- **1.3** — SW caches only small API JSON (≤ 512 KB/entry, 20 MB total budget);
  PDFs/images/HTML left to HTTP caching.
- **2.1** — expansion overlaps `loadIndex()`; rerank skipped when TF-IDF has a
  clear winner (top ≥ 3 and ≥ 2× runner-up) or an explicit page is referenced;
  prewarm threshold aligned to the server's 15 chars.
- **2.2** — home-page modals (`AddGame`, `FindGameModal`, `GameNightPicker`)
  lazy-loaded via `next/dynamic`; home First Load JS 126 kB → 119 kB.
- **2.3/2.4** — index written minified (≈1% smaller for this text-heavy data) and
  built incrementally from per-PDF sidecar caches (`content/games/<slug>/.index-cache.json`),
  processed in parallel; full rebuild 0.5 s when all cached vs ~5 s before.
- **3.1** — home + game page reads wrapped in `unstable_cache` with a `"games"` tag;
  write routes call `revalidateTag("games")` via `invalidateGamesCache()`, so pages
  serve from Next's data cache until the shelf changes.
- **3.2** — per-slug TF-IDF document-frequency tables precomputed once per index load
  (`docFreqFor`) and threaded through `retrieve`/`multiQueryRetrieve`, removing the
  re-tokenization of every chunk on each of the 2–3 retrieve calls per question.
- **3.3** — shelf meta poll (10 s) and health probe (30 s) pause while the tab is hidden
  and fire one immediate poll on return, so background tabs stop hammering the server.
- **3.4** — dead `fuse.js` dependency removed from package.json + lockfile.
- **3.5** — file route supports HTTP byte ranges (`Range: bytes=start-end`, suffix
  `bytes=-N`, 416 on unsatisfiable) so multi-MB PDFs fetch incrementally.
- **3.6** — preconnect origin derived from `UNSLOTH_BASE_URL`; `poweredByHeader: false`.

---

## 0. Measure first (do this before anything else)

Establish a baseline so every change below is verifiable:

- Run Lighthouse on the home page and one game page (mobile + desktop); record
  LCP, TBT, total blocking time, and JS transfer size.
- Run `@next/bundle-analyzer` on a production build to confirm chunk attribution
  (pdfjs-dist ≈ 332 KB, markdown stack ≈ 330 KB, react-dom ≈ 173 KB).
- Take a DevTools heap snapshot in the PDF viewer after full render; record peak
  memory for the largest rulebook (Root: ~6 MB PDF, ~100 pages).
- Extend `logRequest` (or add per-stage timing in `app/api/chat/route.ts`) to
  record RAG stage durations: expand → retrieve → rerank → generation. The audit
  log already captures total `durationMs`; per-stage breakdown makes the RAG
  wins below measurable.

---

## Tier 1 — High impact

### 1.1 PDF viewer: stop rasterizing every page up front (biggest win)

**Where:** `components/pdf-viewer.tsx`, Phase 2 effect (lines ~88–165).

**Why:** Every page of every document is rendered into a canvas at
`RENDER_SCALE = 2`. A US-Letter page at 144 dpi is ≈ 1224 × 1584 px × 4 bytes
≈ **7.7 MB per page**. A 100-page rulebook is ~770 MB of live canvas pixels;
a 60-page one ~460 MB. This causes the long "Brewing the rulebook…" delay
before first paint, scroll jank, and can crash the tab on mobile or low-RAM
machines. Already acknowledged as a known gap in `DOCUMENTATION.md` §12.2.

**What to do — virtualized rendering:**

- Render only pages within a window around the viewport (e.g. visible range ±
  3 pages), driven by scroll position and an initial batch for the first paint.
- Keep a canvas cache with LRU eviction: when a page scrolls far out of the
  window, `canvas.width = 0` (or remove + `page.cleanup()`) to release memory.
- Keep zoom as pure CSS scaling (existing design). If the user zooms beyond the
  rendered scale of a visible page, re-rasterize just that page at the new
  scale.
- The scroll handler (lines ~194–205) currently iterates **every** canvas and
  reads `offsetTop` on each scroll event (layout read per frame). Cache page
  offsets in a plain array after each render pass and binary-search it; wrap
  the handler in `requestAnimationFrame`.

**Expected:** first paint drops from "render whole book" to "render ~7 pages";
peak memory becomes O(window), not O(book); scroll stays smooth.

### 1.2 Lazy-load the markdown stack out of the game page critical path

**Where:** `components/chat-bar.tsx` — static `import ReactMarkdown from
"react-markdown"` + `remark-gfm`.

**Why:** The react-markdown/remark/rehype dependency tree is ~330 KB across
two chunks, and it downloads + parses on **every game page** even when the
user never asks a question (the chat starts as a compact pill).

**What to do:**

- Wrap markdown rendering in a tiny client component that `next/dynamic`
  imports (ssr: false) only when the first assistant message exists. User
  messages can render as plain text until then.
- Keep the compact pill and input fully functional without the markdown chunk.

**Expected:** ~330 KB off the initial JS of every game page; chat UX unchanged
until an answer actually arrives (by which time the chunk has loaded).

### 1.3 Service worker: stop caching multi-MB PDFs and HTML documents

**Where:** `public/sw.js` — the `fetch` handler stores **every** same-origin
GET with status 200, with no size cap and no eviction.

**Why:** `/api/games/[slug]/file?name=rules.pdf` responses are 1–7 MB each;
the five current games alone are ~23 MB of PDFs plus covers. HTML documents
(`/`, `/games/*`) and `search-index.json` are also cached. Cache Storage quotas
are typically 50–100 MB, so the cache grows unboundedly as games are added,
and stale HTML can be served offline indefinitely.

**What to do:**

- Skip caching for binary/large responses: anything with a PDF/image content
  type or body over ~256 KB (the file route already sends ETag +
  `Cache-Control: public, max-age=86400`, so HTTP caching covers it).
- Don't cache HTML documents (or only with a short TTL); keep
  stale-while-revalidate for small API JSON responses.
- Add a total-size budget (e.g. 20 MB) with LRU eviction on `caches.put`.
- Reconsider precaching `search-index.json` in `ASSETS` if it grows past a few
  MB — fetch-on-miss is fine.

**Expected:** bounded cache size, no stale HTML served offline, no quota
failures as the shelf grows.

---

## Tier 2 — Medium impact

### 2.1 RAG: cut one LLM round trip from typical chat questions

**Where:** `lib/rag.ts` (`buildRagContext`) + `app/api/chat/route.ts`.

**Why:** For a non-cached question the pipeline makes up to **two sequential
LLM calls before generation** — `expandQuery` (up to 30 s) then `rerank` (up to
30 s) — on a slow local reasoning model. All LLM calls are also serialized by
the single-flight queue (`lib/llm-queue.ts`), so a second user's question
waits for the first answer to finish streaming.

**What to do:**

1. **Overlap expansion with index loading.** `expandQuery` runs *in parallel*
   with `loadIndex()`, so the LLM call and the index read hide each other's
   latency (the retrieval itself still runs on the expanded variants).
2. **Skip rerank when it isn't needed.** If the top TF-IDF score is well above
   the runner-up (e.g. ratio > 2) or the query has an explicit page reference,
   skip the LLM rerank call entirely — that's a full LLM round trip saved for
   easy questions.
3. **Align prewarm thresholds.** `chat-bar.tsx` fires prewarm at > 20 chars,
   but the route accepts ≥ 15 chars — lower the client threshold to 15 so more
   mid-length questions hit the 60 s prewarm cache.

**Expected:** noticeably faster first token for common questions; less queue
pressure on the single-flight LLM.

### 2.2 Lazy-load the home page modals

**Where:** `components/shelf-section.tsx` — static imports of `AddGame`,
`FindGameModal`, `GameNightPicker`. `add-game.tsx` (664 lines) in turn
statically imports `bulk-add.tsx` (637 lines, CSV ingestion).

**Why:** The home page downloads and parses all modal code — including the
bulk-add machinery — on every visit, even when no modal is ever opened.

**What to do:** `next/dynamic` (ssr: false) each of the three modals in
`shelf-section.tsx`, loading them when their button is first clicked (or
preloading on hover/focus for snappiness).

**Expected:** smaller home-page JS; faster LCP on the most-visited page.

### 2.3 Write the search index minified

**Where:** `scripts/build-index.mjs` — `JSON.stringify(..., null, 2)`.

**Why:** Pretty-printing inflates the file several-fold versus minified JSON
and costs more parse time on every server-side load (it is cached in memory
after the first read, but the file still grows with the shelf).

**What to do:** `JSON.stringify({ generatedAt, entries })` without indentation.

### 2.4 Make index building incremental

**Where:** `scripts/build-index.mjs`.

**Why:** Every `npm run build` re-extracts **all** rulebook PDFs sequentially
(spawned pdfjs child process; OCR fallback up to 12 pages for scanned PDFs).
Adding one game re-does every other game.

**What to do:** Record a per-PDF hash (or size + mtime) in a sidecar file
(e.g. `content/games/<slug>/.index-cache.json`); skip unchanged PDFs and only
re-extract changed ones; parallelize across games.

**Expected:** `npm run build` time drops from "all games" to "changed games".

---

## Tier 3 — Lower impact / polish

### 3.1 Replace `force-dynamic` with Next's data cache

**Where:** `app/page.tsx` and `app/games/[slug]/page.tsx`.

**Why:** Both pages are `force-dynamic`, so every request re-renders
server-side and re-reads all `meta.json` files (mitigated by the 30 s in-memory
TTL in `lib/games.ts`, but the HTML is never cached).

**What to do:** Read games through `cache()`/`unstable_cache` with
`revalidateTag("games")`, invalidate that tag in the write routes (they
already call `invalidateGamesCache()` — add the tag revalidation there), and
let pages serve stale-while-revalidate. Modest win for a personal site, but
free.

### 3.2 Precompute the TF-IDF document-frequency table

**Where:** `lib/retrieve.ts` — `retrieve()` tokenizes every chunk to build the
DF/IDF table on **each call**, and `multiQueryRetrieve` calls it 2–3× per
question.

**What to do:** Build the DF table once per index load (alongside
`loadIndex()`'s mtime-aware cache) and reuse it across queries. Fine at the
current scale; matters as the shelf grows.

### 3.3 Pause polling when the tab is hidden

**Where:** `components/shelf-section.tsx` (10 s poll of `/api/games/meta`) and
`components/health-strip.tsx` (30 s poll of `/api/health`).

**What to do:** Gate both intervals on `document.visibilitychange` — pause when
hidden, resume (and fire one immediate poll) when visible. Cheap win; also
reduces load on the LLM health probe.

### 3.4 Remove the dead `fuse.js` dependency

**Where:** `package.json`.

**Why:** Only referenced from test files; no component uses it (the README's
"fuse.js (client)" search was removed with the `/search` page). Removing it
keeps installs and the lockfile clean.

### 3.5 File route: support byte-range requests

**Where:** `app/api/games/[slug]/file/route.ts`.

**Why:** The route reads the whole file into memory per request. For multi-MB
PDFs, range requests let browsers fetch incrementally and make deep-linking
into a PDF cheaper.

**What to do:** Handle `Range` headers and return `206 Partial Content` with
`Content-Range`. (Nice-to-have; local single-user impact is small.)

### 3.6 Misc

- **Preconnect should come from the environment.** `app/layout.tsx` hardcodes
  `<link rel="preconnect" href="http://localhost:8888" />`; derive it from
  `UNSLOTH_BASE_URL` so a moved LLM server doesn't silently break preconnect.
- **`next.config.mjs`:** add `poweredByHeader: false` (trivial hygiene).

---

## Tier 4 — Decision-model RAG (fast classification + relevance scoring)

### 4.1 Use the small `kev-0.8b` decision model for pipeline decisions

**Where:** `lib/decision-model.ts` (new), `lib/rag.ts`, `app/api/chat/route.ts`,
`app/api/chat/prewarm/route.ts`.

**Why:** The RAG pipeline burns its slow 27B reasoning model on *decisions* —
query classification (via a keyword heuristic) and candidate relevance scoring
(the LLM re-rank, up to 30 s). A small dedicated classifier (`kev-0.8b`, served
at `<UNSLOTH_BASE_URL>/systemone`) answers a batch of structured questions in
~0.5 s: multiple choice (`choice`), yes/no probability (`noul`), and ordered
rating (`score`). Spending ~0.5 s on decisions lets the slow model focus on
generation.

**What was done:**

- `lib/decision-model.ts` — typed client for `/systemone`
  (`askDecisionModel`, `askChoice`); returns `null` on any failure so callers
  always fall back to the existing behavior. URL resolved from env at call time.
- `lib/rag.ts` — opt-in `RagOptions.useDecisionModel` (default **off**, so the
  current pipeline is byte-for-byte unchanged and A/B benchmarking is clean):
  - `decisionClassify()` runs in parallel with `loadIndex()`, replacing the
    keyword `classifyQuery` (choice) and gating `expandQuery` on a `noul`
    "needs rephrasing" verdict instead of the length heuristic.
  - `decisionRerank()` replaces the LLM re-rank with one batched `score` call
    over all candidates, combined with TF-IDF using the same 3:1 weighting as
    `rerank()`, so orderings stay comparable.
- Both chat routes pass `{ useDecisionModel: USE_DECISION_MODEL === "1" }`
  (env opt-in, default off).

**Benchmark** (`lib/__tests__/rag-benchmark.test.ts`; live numbers from the
2026-11-12 re-baseline against the real endpoints, 32-case labeled dataset
grounded in all five rulebooks — Agricola, Catan, Container, Nemesis:
Lockdown, Root). The retrieval metrics below measure what the LLM actually
sees — in-context/in-excerpts membership and MRR/recall@3 over `rankedPages`
(relevance order) — not page-number order:

| Metric | Existing (keyword + LLM) | Enhanced (decision model) |
| --- | --- | --- |
| Classification accuracy (32 cases) | 37.5% | **50.0%** |
| Retrieval in-context hit rate | **93.8%** | 90.6% |
| Retrieval in-excerpts hit rate | **93.8%** | 90.6% |
| Retrieval MRR (over `rankedPages`) | **70.9%** | 58.2% |
| Retrieval recall@3 (over `rankedPages`) | **81.3%** | 76.6% |
| End-to-end latency (mean) | ~37.7 s | **~8.8 s** |
| Re-rank, hard question ("turmoil", p. 13) | ~30.0 s, top-1 correct | **~6.2 s**, top-1 correct |
| Raw batched score call (3 candidates) | — | ~1.5 s |

Per-case divergence (in-context hit): existing-only hits 1 · enhanced-only
hits 0 · **both miss 2 of 32** (Agricola "Minor Improvement cards", expected
p. 3; Catan "How does trading work?", expected pp. 11+14).

**Metric correction (issue #50):** the first baseline's retrieval rows (top-1
9.4%/0%, MRR 33.2%/25.4%, recall@3 42.2%/35.9%, "both miss 17 of 32") were a
metric artifact — they scored `pages` sorted by *page number* as if it were a
relevance ranking. A live 17-case trace showed the answer page's text was in
the injected `excerpts` in every one of those "missed" cases: the document
reached the LLM, the metric just couldn't see it. The corrected numbers above
show retrieval effectiveness is far stronger than first reported (93.8%/90.6%
in-context) and that only 2 of 32 cases genuinely miss in both modes.

**BM25 A/B (issue #51):** `retrieve()` gained a `scoring` option
(`"tfidf"` | `"bm25"`, standard BM25 with k1=1.2, b=0.75; same idf and phrase
bonuses in both modes). A live A/B run of the existing pipeline
(`useDecisionModel: false`) on all 32 cases, `scoring: "bm25"` vs the TF-IDF
baseline above:

| Metric | TF-IDF (previous default) | **BM25** |
| --- | --- | --- |
| Retrieval in-context hit rate | 93.8% | **96.9%** |
| Retrieval in-excerpts hit rate | 93.8% | **96.9%** |
| Retrieval MRR (over `rankedPages`) | 70.9% | **77.6%** |
| Retrieval recall@3 (over `rankedPages`) | 81.3% | **87.5%** |

BM25 wins every aggregate metric and fixes both known-miss cases — Catan
"How does trading work?" (pp. 11+14 now in context) and Agricola "Minor
Improvement cards" (p. 3 → rank 2) — at the cost of one new miss (Nemesis
"What happens when an Intruder appears…", p. 20 out of top-3). Net +1 case
(31/32 vs 30/32), matching the deterministic 21-case diagnostic
(`lib/__tests__/_diag-bm25.test.ts`: 19/21 top-3 vs 18/21). **BM25 is now the
default** in `retrieve()` / `multiQueryRetrieve` / `buildRagContext`; TF-IDF
remains available via `scoring: "tfidf"`.

**Honest read:**

- **Latency is the clear win:** ~4.3× faster end-to-end (8.8 s vs 37.7 s),
  driven by replacing the up-to-30 s LLM re-rank with a ~1.5–6.2 s batched
  score call and hiding classification behind `loadIndex()`. (The existing
  pipeline's latency in this run — ~37.7 s vs ~12.8 s in the first baseline —
  reflects server load during the long sequential live run; a single LLM
  re-rank measured in the same run took ~30 s.)
- **Retrieval effectiveness is not the clear loss it first appeared to be:**
  with corrected metrics both pipelines put an answer page in context for 9+
  of every 10 questions, and in-excerpts hit rate equals in-context hit rate
  in both modes (the context budget never dropped an expected page). The LLM
  pipeline still leads on ranking quality (MRR 70.9% vs 58.2%, recall@3
  81.3% vs 76.6%) and wins the divergent cases 1-to-0 — consistent with the
  `kev-0.8b` score clustering that adds little discriminative signal over
  TF-IDF, and with the `noul` "needs rephrasing" verdict skipping LLM
  expansion that would have helped on some paraphrased questions.
- **The genuine misses are upstream of the re-rank:** under TF-IDF, Catan
  "How does trading work?" (expected pp. 11+14) and Agricola "Minor
  Improvement cards" (expected p. 3) missed in both modes — base retrieval
  couldn't find those pages for those phrasings, regardless of which re-ranker
  runs. The BM25 default (issue #51) fixes both; the one remaining miss is
  Nemesis "What happens when an Intruder appears…" (expected p. 20). Further
  gains (better expansion, embedding retrieval, or a stronger candidate pool)
  would help both modes.
- Classification accuracy (50% vs 37.5%) is a real but modest gain; the
  `kev-0.8b` model discriminates less than a reasoning model would.

**Follow-ups (not done):** tune the expansion gate (trust the `noul` verdict
only above a confidence threshold); consider skipping the decision-model score
call when TF-IDF has a clear winner (it adds ~0.5 s without changing orderings);
invest in base retrieval quality, which is where the one remaining miss lives.

### 4.2 Prompt engineering for the clustered `score` problem

The §4.1 benchmark showed the decision model's relevance scores cluster tightly
(≈2.1–2.3 on the 0–4 scale), adding no discriminative signal over TF-IDF. This
section records a systematic prompt-probe campaign against the live endpoint
to fix that, and the design it produced.

**Method.** For each grounded question (1 known-relevant chunk + 3 known-
irrelevant chunks from the same rulebook) we batch all candidates in one
`score` call and measure: *gap* (mean good−bad score), *top-1 hit rate*
(fraction where the good chunk scores highest), and *spread* (std dev of all
scores). Variants are compared on identical candidate sets; runs are repeated
to check stability (the model is deterministic — scores identical to 2 decimals
across runs).

**Round 1 — framing variants (4 candidates, raw ~200-char previews):**

| Variant | Top-1 | Gap | Note |
| --- | --- | --- | --- |
| V0 baseline (per-excerpt instructions) | 60% | 0.15 | current wording; scores cluster ≈2.2–2.6 |
| V1 sharp level definitions (verbose rubric per question) | 40% | 0.00 | **worse** — a 0.8B model can't handle fine-grained criteria |
| V2 comparative `state` (question + ALL excerpts visible) | **80%** | **0.37** | scores candidates *relative to each other* |
| V3 coarse 3 levels | 60% | 0.08 | coarseness alone doesn't help |

Key finding: the model discriminates only when it can see all candidates at
once and compare them; judging each excerpt in isolation clusters everything
mid-scale. The rubric stated **once** in `state` (not repeated per question)
cuts tokens with no quality loss, and longer previews *hurt* (80% → 60% top-1
going 200 → 300 chars — the relevant fact gets buried in noise for a 0.8B
model). Winner: comparative framing + rubric-in-state + ~200-char previews
(~1.3 k tokens, ~3 s/call).

**Production-scale failure.** The pipeline passes **8** candidates to re-rank.
At that scale the comparative call (a) runs 10–13 s — past the 8 s timeout, so
`decisionRerank` returns `null` and silently falls back to the slow LLM
re-rank, and (b) **inverts** scores: the good chunk ranks last (e.g. 1.54 vs
max-bad 1.84). Rescue probes at 8 candidates all fail:

| Strategy | Top-1 | Latency |
| --- | --- | --- |
| `score`, 200-char sentence previews, 8 cand. | 0% (good loses all 3) | 10–13 s |
| `score`, 100-char sentence previews, 8 cand. | 0% | 6.6–8.2 s |
| `choice` ("which excerpt answers?"), 8 options | 0%, confidence 0.05–0.18 (near-uniform) | ~1.2–1.6 s |

**Preview-type isolation (top-4, same question sets):**

| Preview | Top-1 | Gap |
| --- | --- | --- |
| Query-term sentence extraction (what production used) | **0%** | −0.21 |
| Raw ~200-char prefix slices | **67%** (2/3) | +0.08 |

This is the decisive insight: **`kev-0.8b` judges by surface keyword overlap,
not semantic relevance.** Section headings carry the query terms ("Turmoil If
you cannot take an action…"), so raw prefix slices let the good chunk win on
lexical match; sentence extraction strips that heading context and the model
loses every time. The one question that loses in *both* configs (turmoil, p. 13)
has no strong lexical signal in its answer chunk — a capacity limit no prompt
fixes.

**Resulting design** (integrated in `decisionRerank`): comparative framing with
rubric-in-state, **top-4 shortlist only** (where discrimination is proven and
the call fits the timeout at ~3 s), **raw prefix previews**, remaining
candidates untouched in TF-IDF order. Cost ~1.3 k tokens / ~3 s vs up to 30 s
for the LLM re-rank it replaces.

**Benchmark (top-4 comparative, live, 2026-11-12, 32 cases):**

| Metric | Existing (keyword + LLM) | Enhanced (top-4 comparative) |
| --- | --- | --- |
| Retrieval top-1 hit rate | 3.1% | 0.0% |
| Retrieval MRR | **31.3%** | 26.1% |
| Retrieval recall@3 | **45.3%** | 35.9% |
| End-to-end latency (mean) | ~13.4 s | **~3.7 s** |
| Re-rank, hard question ("turmoil", p. 13) | ~18.8 s, top-1 correct | **~6.4 s, top-1 correct** (previously timed out → LLM fallback) |

Per-case divergence (top-3 hit): existing-only hits 3 · enhanced-only hits 0 ·
both miss 17 of 32.

**Verdict:** prompt engineering fixed the *symptom* — scores no longer cluster
(probe gap −0.21 → +0.08) and the hard question that lost in every probe is now
correct at ~6 s instead of timing out — but it did not change the end-to-end
outcome. Retrieval quality still trails the existing pipeline on every metric,
because the binding constraint is upstream: TF-IDF base retrieval misses 17 of
32 questions, and a 0.8B classifier's shallow keyword-matching signal cannot
recover what retrieval never found. Where TF-IDF *does* surface the answer, the
3:1 score weighting occasionally displaces it from the top-3 (existing-only
hits 3, enhanced-only 0). The decision model's durable value remains
classification (50% vs 37.5%) and latency (~3.7 s vs ~13.4 s); the opt-in flag
stays **default-off**, and the investment case for accuracy is base retrieval
(embeddings / larger candidate pool), not re-rank prompting.

---

## Suggested order

1. Measurement baseline (§0) — half a day.
2. **1.1 PDF virtualization** — the largest user-facing win; do it first.
3. **1.2 markdown lazy-load** + **2.2 home modal lazy-load** — small, safe,
   immediate bundle wins.
4. **1.3 SW scoping** — prevents a slow-burn failure (cache quota).
5. **2.1 RAG latency** — biggest perceived-latency win for chat.
6. **2.3 + 2.4** build/index file work — dev-experience wins.
7. Tier 3 items as time allows.

Each tier is independently shippable; nothing in Tier 3 blocks Tiers 1–2.
