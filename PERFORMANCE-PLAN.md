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
LLM calls before generation** — `expandQuery` (up to 20 s) then `rerank` (up to
20 s) — on a slow local reasoning model. All LLM calls are also serialized by
the single-flight queue (`lib/llm-queue.ts`), so a second user's question
waits for the first answer to finish streaming.

**What to do:**

1. **Overlap retrieval with expansion.** Run TF-IDF retrieval on the raw
   query *in parallel* with `expandQuery`, then merge both result sets in
   `multiQueryRetrieve`. The expansion latency is hidden behind retrieval.
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
