# Board Game Parlor — Technical Documentation

> A self-hosted, cozy "bookish coffee shop" catalog of board games. Each game
> gets a page with a cover, an LLM-written description, a searchable PDF
> rulebook, and a chat bar that answers rules questions grounded in the actual
> rulebook text (RAG) via a local Unsloth LLM server.

This document is the canonical technical overview: what exists, how it fits
together, and — importantly — what is **not** finished or is **dead code**.
For the short version, see `README.md`. For design tokens, see `STYLE.md`.

---

## 1. Status at a glance

| Milestone | Scope | Status |
|-----------|-------|--------|
| M0 | Plan | ✅ Complete |
| M1 | Scaffold + content pipeline (PDF → search index) | ✅ Complete |
| M2 | Home page, grid, search, filters | ✅ Complete (the `/search` page was later removed; see §12) |
| M3 | Game subpage + PDF viewer | ✅ Complete |
| M4 | RAG chat + citations | ✅ Complete |
| M5 | Polish, security, performance, PWA, ops | ✅ Complete |
| Post-M5 | Edit-game / edit-rulebook UX, bulk add, expansions, concepts, checklist, pairs | ✅ Complete |

- **Test suite:** 308 tests across 15 files (`npm test`).
- **Server (production):** `http://localhost:3111` (`npm start`).
- **Build:** `npm run build` (runs the search-index build, then `next build`).
- **Games currently shelved:** Nemesis: Retaliation, Spirit Island, Agricola,
  Tacta, Container, Kabuto Sumo, Monopoly, Betrayal at House on the Hill,
  Carcassonne (plus any added since).

---

## 2. Tech stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 15 (App Router) + React 19 |
| Styling | Tailwind CSS 4 (CSS-first config, no `tailwind.config.js`) |
| Language | TypeScript (strict) |
| PDF rendering (client) | `pdfjs-dist` |
| PDF extraction (server) | `pdfjs-dist` legacy build in a child process (`lib/extract-cli.mjs`) |
| OCR fallback | ghostscript (`gs`) → PNG → `tesseract` (`lib/ocr-pdf.mjs`) |
| Cover rendering | ghostscript (`gs -sDEVICE=jpeg`) |
| Chat rendering | `react-markdown` + `remark-gfm` |
| Client fuzzy search | `fuse.js` |
| Retrieval | Custom TF‑IDF (`lib/retrieve.ts`) + multi-stage RAG (`lib/rag.ts`) |
| LLM | Local Unsloth server (OpenAI-compatible `/v1`) |
| Tests | Vitest + Testing Library (jsdom) |
| PWA | Service worker + manifest |

---

## 3. Repository layout

```
app/
  layout.tsx                 Root layout: fonts, header, footer/HealthStrip, PWA, SW
  page.tsx                   Home: hero, GameFinder, ShelfSection, GameNightPlanner, HiddenGames
  not-found.tsx              404 page
  globals.css                Tailwind theme tokens + global styles (:focus-visible ring)
  games/[slug]/page.tsx      Game subpage (cover, meta, FAQ, chat, viewer, expansions, below-fold)
  api/…                      See §5.1

components/                  Client UI (32 components; see §5.2)
hooks/
  use-dialog.ts              Accessible modal hook (Escape, focus trap/restore)
lib/                         Server-side logic (see §5.3)
scripts/
  build-index.mjs            PDF text extraction → public/search-index.json
  backup.mjs                 Tar content/games + index into backups/
content/
  known-rulebooks.json       Learned rulebook URLs + publisher base URLs
  games/<slug>/              Per-game folder (see §8)
public/
  search-index.json          Build-time/runtime TF-IDF chunk index
  manifest.json              PWA manifest
  sw.js                      Service worker
logs/
  audit.log                  JSON-lines API request log (gitignored)
middleware.ts                Security headers + body-size limit
```

---

## 4. Pages

### 4.1 Home (`/`)
1. Hero (`Board Game Parlor` + tagline).
2. `GameFinder` — natural-language game search.
3. `ShelfSection` — the three action buttons ("Find a Game", "Pick a Game",
   "+ Add a Game") in a single `flex` row, plus the game grid with sort.
4. `GameNightPlanner` — pick a game for tonight.
5. `HiddenGames` — "Off the shelf" section with restore.

`export const dynamic = "force-dynamic"` so newly added games appear without a
rebuild.

### 4.2 Game subpage (`/games/[slug]`)
Rendered top-to-bottom:
1. Cover image (`object-cover`, height `h-96`).
2. Title + `EditGame` (pencil) + `GameMeta` (players/playtime/age/tags/suggestions).
3. `DescriptionBlock` — LLM description with a "brewing" state; placeholder if
   there is no rulebook yet.
4. `Rating` (1–5 stars).
5. `Faq` — 2×2 starter-question grid (single column on phones).
6. `ChatBar` — inline (not sticky), just above the rulebook.
7. Rulebook section — `AddRulebook` (label "Edit rulebook" or "Add a rulebook")
   + `PdfViewer`.
8. `Expansions`.
9. `BelowFold` — lazy-loaded `KeyConcepts`, `SetupChecklist`, `NotesSection`,
   `PlayLog`, `PairsWith`, `SimilarGames`. When no rulebook exists, the
   LLM-dependent sections show a themed placeholder.

---

## 5. Architecture

### 5.1 API routes

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/chat` | POST (SSE) | RAG chat; streams tokens |
| `/api/chat/prewarm` | POST | Speculative RAG prewarm (60 s TTL cache) |
| `/api/find-game` | POST | LLM game recommendations (two-stage: prefilter → LLM) |
| `/api/health` | GET | LLM/index/shelf status probe |
| `/api/games` | GET, POST | List / create a game (PDF **required**) |
| `/api/games/meta` | GET | Lightweight shelf list for polling (desc/complexity live updates) |
| `/api/games/visible` | GET | Slugs currently on the shelf |
| `/api/games/lookup` | POST | Metadata lookup (BGG → Wikipedia → officialgamerules → web) |
| `/api/games/fetch-rulebook` | POST | 4-strategy rulebook PDF finder |
| `/api/games/bulk-lookup` | POST | Look up many game names |
| `/api/games/bulk-add` | POST | Start an async bulk-add job |
| `/api/games/bulk-add/[jobId]` | GET | Poll bulk-add progress |
| `/api/games/[slug]` | GET, PATCH | Read / edit metadata (`null` clears a field) |
| `/api/games/[slug]/file` | GET | Serve cover/PDF on demand (ETag + cache) |
| `/api/games/[slug]/cover` | POST | Upload/replace cover (magic-byte validated) |
| `/api/games/[slug]/rulebook` | POST, GET | Replace rulebook + re-digest / poll status |
| `/api/games/[slug]/expansions` | POST, PATCH, DELETE | Manage expansions |
| `/api/games/[slug]/checklist` | GET, POST | Setup checklist |
| `/api/games/[slug]/concepts` | GET, POST | Key gameplay concepts |
| `/api/games/[slug]/rating` | GET, POST | Personal rating |
| `/api/games/[slug]/bookmarks` | GET, POST, DELETE | PDF bookmarks |
| `/api/games/[slug]/plays` | GET, POST | Play log |
| `/api/games/[slug]/notes` | GET, POST | Per-game notes |
| `/api/games/[slug]/toc` | GET | Per-page TOC labels |
| `/api/games/[slug]/pairs` | GET | "Pairs well with" suggestions |
| `/api/games/[slug]/suggestions` | POST | Accept/dismiss metadata suggestions |
| `/api/games/[slug]/remove` | POST, DELETE | Hide / restore / delete |
| `/api/notes` | GET, POST | Aggregate notes access |
| `/api/plays` | GET | Aggregate last-played per game |

### 5.2 Components (client)

Core page pieces: `description-block`, `game-meta`, `chat-bar`, `pdf-viewer`,
`add-game`, `add-rulebook`, `bulk-add`, `edit-game`, `expansions`,
`setup-checklist`, `key-concepts`, `pairs-with`, `similar-games`, `faq`,
`rating`, `play-log`, `notes-section`, `remove-game`, `hidden-games`,
`shelf-section`, `game-grid`, `game-finder`, `find-game-modal`,
`game-night-picker`, `game-night-planner`, `saved-searches`, `health-strip`,
`theme-toggle`, `cover-tint`, `welcome-toast`, `keyboard-shortcuts`,
`below-fold`.

### 5.3 Library modules

| Module | Responsibility |
|--------|----------------|
| `lib/games.ts` | `GameMeta` types, `listGames`/`getGame`/`listHiddenGames`, 30 s TTL cache |
| `lib/rag.ts` | 11-stage RAG pipeline |
| `lib/retrieve.ts` | TF-IDF retrieval, `sanitizeChunkText`, page maps/TOC |
| `lib/lookup.ts` | Shared metadata lookup (BGG → Wikipedia → officialgamerules → web) |
| `lib/fetch-rulebook-core.ts` | 4-strategy PDF finder + downloader |
| `lib/fetch-rulebook-utils.ts` | URL/PDF helpers, language detection, SSRF guards, size caps, `safeFetch` |
| `lib/digest-rulebook.mjs` | Async digest: extract → index → description → metadata → complexity → suggestions |
| `lib/bulk-add-queue.ts` | In-memory bulk-add job queue (13 s spacing, 1 h prune) |
| `lib/generate-concepts.ts` | Key concepts generation/persistence |
| `lib/generate-checklist.ts` | Setup checklist generation/persistence |
| `lib/generate-pairs.ts` | "Pairs well with" generation |
| `lib/llm-queue.ts` | Single-flight LLM serialization |
| `lib/rate-limit.ts` | In-memory per-IP limiter |
| `lib/guard.ts` | Prompt-injection guard + input validation |
| `lib/auth.ts` | Optional bearer-token auth |
| `lib/audit-log.ts` | JSON-lines request logging |

### 5.4 PDF helper CLIs (`.mjs`)
- `extract-cli.mjs` — child-process PDF text extraction (used by digest + expansions).
- `extract-pdf.mjs` — shared extraction helper.
- `ocr-pdf.mjs` — ghostscript → tesseract OCR (used by digest + build-index).
- `render-cover.mjs` / `render-cover-cli.mjs` — ghostscript cover rendering.

---

## 6. Feature inventory

### 6.1 Home & discovery
- **Find a Game** modal: natural language → up to 3 recommendations with reasons.
  Request only fires on button click. Two-stage pipeline, in-memory cache
  (200 entries, fingerprint-invalidated).
- **Pick a Game** modal: player count / max minutes / mood chips
  (Relaxing, Competitive, Cooperative, Heavy, Light). Moods call
  `/api/find-game`; otherwise local scoring.
- **Saved searches** auto-saved after a successful find; one-tap chips.
- Game grid with sort (title, rating, recently played), complexity dots.
- No tag dropdown (tags are plain labels on cards).

### 6.2 Game page
- Cover, LLM description (brewing state), metadata, personal rating.
- FAQ grid above the chat.
- Inline chat bar above the rulebook.
- Key Gameplay Concepts (collapsible; multiple page links per concept).
- Setup checklist (collapsible; manual trigger; setup timer).
- "Pairs well with" and "If you liked this, try…" — identical card layout
  (`h-24 w-24` cover, same fonts/spacing, responsive 2-col grid).
- Personal notes + play log.
- Edit Game modal (title, description, players, playtime, age, tags, cover).
- Add/Edit Rulebook unified modal.

### 6.3 PDF viewer
- Discrete zoom 100 / 150 / 200 % (CSS-only; keeps current page).
- Current-page tracking, bookmarks, TOC drawer, theme cycling
  (normal / sepia / dark), shareable `?page=N` links, fullscreen.
- "Ask about p. N" → focuses chat with that page.
- Jump-to-page: centers target, ~100 ms ease-out scroll, skipped if visible,
  brings viewer into view on mobile.
- Expansion PDFs appended as one continuous document.
- Re-fetches in place on `rulebook-updated` (cache-buster + full re-rasterize).

### 6.4 Chat & RAG
11-stage pipeline (`lib/rag.ts`): query classification → explicit-page
detection → LLM query expansion (skipped for short/page queries) → multi-query
TF-IDF retrieval → page boost → expansion boost → LLM rerank →
cross-reference follow → adaptive context budget → confidence estimate →
hierarchical TOC.

UI: SSE word-by-word streaming, Markdown + GFM tables, clickable in-text and
pill citations (ascending, deduped), fullscreen, "Simple" mode, optional
second-game comparison, speculative prewarm cache, expansion awareness in the
system prompt. History is in-memory only (per page visit).

### 6.5 Add game / add rulebook / edit
- Add Game modal: "Rulebook source" dropdown (Intellisearch / Link / Manual);
  only the selected method's UI is visible.
- Intellisearch: Wikipedia/BGG/web metadata autofill + 4-strategy rulebook find,
  URL confirmation before accept, dismiss-and-retry (3 follow-ups), language
  filter, base-game validation.
- Link: paste a direct PDF URL.
- Manual: drag-and-drop PDF + cover.
- **PDF is required** for creation (400 without it; frontend pre-validates).
- Add/Edit Rulebook modal: same three source methods, no title field.
  "Upload" button → after success becomes "Alright" (dismisses modal; no digest
  polling in the modal). Replacing a rulebook triggers a full re-digest that
  **overwrites** metadata (players/playtime/age/tags).
- Edit Game modal: dirty-field tracking; cleared fields sent as `null`.
- Add Game and Bulk Add warn if the game already exists on the shelf.

### 6.6 Bulk add
- CSV upload or paste list of game names.
- Look up in bulk, then add selected games asynchronously via a server-side
  background job (13 s between external fetches; 1 h prune).
- "Add without rulebook" option: games are shelved even if no PDF is found;
  page shows a "waiting for the rulebook" placeholder, and adding a rulebook
  later runs the full digest.
- Confirmation message + "Alright" closes both modals; shelf updates in the
  background.

### 6.7 Expansions
- Added via the same Intellisearch / Link / Manual modal.
- Per-expansion chat-context toggle (indexes its text under the parent slug).
- Page numbers offset after the base game's last page.
- Enabled expansions appended to the viewer and named in the system prompt.

### 6.8 UX / accessibility
- All modals: `role="dialog"`, `aria-modal`, Escape-to-close, initial focus,
  focus restoration (`useDialog`).
- Icon-only buttons and inputs have `aria-label`s.
- PDF canvases: `role="img"` + `aria-label`.
- Global `:focus-visible` ring.
- Brewing steam animation in every loading state; "Still brewing…" after 15 s;
  description polling gives up after ~60 s with a fallback message.
- Upload buttons show file size (MB).
- Keyboard: `/` focuses chat, `Ctrl+K` focuses search.
- First-visit onboarding toast (localStorage-gated).
- Dark mode "☾ Evening" / "☀ Daylight".
- Frosted-glass header + chat bar (`bg-parchment/75` + `dark:bg-nightcard/80`,
  backdrop blur); all page sections tinted (`bg-parchment/40` +
  `dark:bg-nightcard/60`).

### 6.9 Security
- Per-IP rate limits (chat 10/min, find-game 5/min, lookup 5/min,
  fetch-rulebook 5/min, upload 3/min, bulk-lookup 5/min, bulk-add 3/min).
  Note: `getClientIp()` returns a fixed `"direct"` (no reverse proxy), so all
  clients share one budget.
- Input caps (chat 1000, finder 500, bulk 50×200 chars).
- Prompt-injection guard (`lib/guard.ts`).
- Single-flight LLM queue + timeouts.
- Body-size limit (100 KB) via middleware; upload routes exempt
  (`experimental.middlewareClientMaxBodySize: "100mb"`).
- Security headers (nosniff, DENY framing, referrer policy, permissions policy).
- Optional bearer auth (`PARLOR_AUTH_TOKEN`) on LLM-burning POST endpoints.
- Audit log (`logs/audit.log`).
- SSRF protection: `isSafeUrl` (DNS resolution + private/reserved blocking) and
  `safeFetch` (manual redirects, max 5 hops, re-validate each) with pinned-IP
  fetch to prevent DNS rebinding.
- PDF cap 100 MB; HTML cap 1 MB; streaming readers.
- Cover upload magic-byte validation.

### 6.10 Performance
- Preconnect to LLM; PDF ETag + `Cache-Control`; 30 s metadata cache.
- Below-fold lazy loading (`next/dynamic`, `ssr: false`).
- `next/image` for covers.
- SW stale-while-revalidate for same-origin GET.
- RAG skips LLM expansion for short queries; speculative prewarm.
- PDF pages rasterized once at 2× in batches of 5; zoom is pure CSS.
- No PDF virtualization (intentional: fast paging; upfront rasterization OK).

### 6.11 PWA
- `manifest.json` (standalone, theme `#8b5e3c`).
- `sw.js` — stale-while-revalidate for same-origin GET/API.

---

## 7. Key data flows

### 7.1 Add a game
1. Client validates a PDF is attached.
2. `POST /api/games` (multipart): saves `rules.pdf` (+ optional cover), writes
   `meta.json`, renders a cover if missing, spawns the async digest.
3. Digest (`lib/digest-rulebook.mjs`): extract text → merge into
   `public/search-index.json` → LLM description → metadata fill → complexity →
   metadata suggestions.
4. Client polls until the description appears.

### 7.2 Rulebook acquisition (4 strategies, `lib/fetch-rulebook-core.ts`)
1. Known URLs — persistent cache + static dictionary + publisher patterns.
2. Publisher base-URL probe — learned directory structure.
3. Targeted web search (Brave API; domain-scoped if known).
4. Publisher site scan (one level deep).

On success, the URL (and publisher base URL) is persisted to
`content/known-rulebooks.json`. Validation: `%PDF` magic bytes, size cap,
base-game vs expansion check (skipped when `isExpansion: true`), language check.

### 7.3 Rulebook replacement / re-digest (`POST /api/games/[slug]/rulebook`)
1. Save new PDF over the old one.
2. Delete old `concepts.json` and `checklist.json` (user must regenerate).
3. Write a `.digesting` marker **before** responding; in-flight guard rejects a
   concurrent re-digest (409).
4. Background `reDigest`: re-extract + re-index → **overwrite** description and
   metadata → recompute complexity. Does **not** regenerate concepts/checklist.
5. `GET` on the same route reports `{ done }`; a `.digesting` marker older than
   30 min is treated as a crash and cleaned up.
6. Client: `rulebook-replaced` resets description/concepts/checklist to
   "brewing"/"not loaded"; `rulebook-updated` (on modal close) triggers refetch
   and PDF re-rasterization. No page reload. While `.digesting` exists,
   `GET /api/games/[slug]` returns an empty description so stale text is never
   shown.

### 7.4 Bulk add
`POST /api/games/bulk-add` → `startBulkJob()` → in-memory `Map<jobId, job>` →
`processJob()` looks up and creates each game with 13 s spacing → client polls
`GET /api/games/bulk-add/[jobId]` every 5 s. Duplicate slugs are marked
`"duplicate"`. Jobs pruned after 1 h.

### 7.5 "Pairs well with"
`generatePairs()` → persisted to `meta.json` as `pairsWith` + `pairsFingerprint`.
`GET /api/games/[slug]/pairs` caches after the first call and regenerates when
the shelf fingerprint (sorted `slug:title` joined with `|`) changes.

---

## 8. Data model

### `content/games/<slug>/meta.json`
```json
{
  "title": "Game Name",
  "description": "LLM-generated lore-first blurb.",
  "image": "cover.jpg",
  "pdf": "rules.pdf",
  "players": "1–4",
  "playtimeMinutes": 90,
  "ageRating": "12+",
  "tags": ["cooperative", "sci-fi"],
  "complexity": 3,
  "hidden": false,
  "suggestions": [],
  "expansions": [
    { "name": "Voidseeders", "pdf": "expansion-voidseeders.pdf", "inChatContext": true }
  ],
  "pairsWith": [{ "slug": "spirit-island", "reason": "…" }],
  "pairsFingerprint": "slug:title|…"
}
```

### Runtime files (per game)
`concepts.json`, `checklist.json`, `rating.json`, `bookmarks.json`,
`plays.json`, `notes.json`, `.digesting` (marker).

### Search index entry (`public/search-index.json`)
```json
{ "id": "nemesis-lockdown-p4", "slug": "nemesis-lockdown", "title": "Nemesis: Lockdown", "page": 4, "text": "…", "isExpansion": false }
```
Expansion chunks use the **parent slug** (so RAG's `slug` filter catches them)
and offset page numbers.

---

## 9. Configuration

`.env` (see `.env.example`):

| Variable | Required | Notes |
|----------|----------|-------|
| `UNSLOTH_API_KEY` | Yes | LLM API key |
| `UNSLOTH_BASE_URL` | Yes | e.g. `http://localhost:8888/v1` |
| `UNSLOTH_MODEL` | Yes | Model ID |
| `BRAVE_SEARCH_API_KEY` | For intellisearch | Brave Search fallback |
| `PARLOR_AUTH_TOKEN` | No | Protect LLM/personal-data endpoints |

All modules read the same `UNSLOTH_BASE_URL` variable (the former
`UNSLOTH_URL` mismatch in the game finder was fixed — see §12).

---

## 10. Testing

```bash
npm test          # 308 tests / 15 files
npm run test:watch
```

- `vitest.config.mts` (ESM), `vitest.setup.tsx` (mocks Next modules).
- API tests: `fetch-rulebook`, `lookup`.
- Lib tests: `rag`, `rag-pipeline`, `retrieve` (via rag), `rate-limit`,
  `ssrf-guard`, `fetch-rulebook-utils`.
- Component tests: `add-rulebook`, `chat-bar`, `find-game-modal`, `game-grid`,
  `game-meta`, `health-strip`, `shelf-section`.
- Page test: `not-found`.

---

## 11. Operations

```bash
npm install
npm run dev            # dev server (hot reload)
npm run build          # build:search + next build
npm start              # production on :3111
npm run build:search   # re-extract all PDFs → public/search-index.json
npm run backup         # tar content/games + index into backups/ (keeps 10)
```

Common failure modes (LLM offline, extraction failure, port conflict, disk full,
stale index, audit log) are documented in `README.md` §"When Things Go Wrong".

---

## 12. Known gaps — unfinished features & dead code

This section is the explicit call-out requested during documentation. The
cleanup items that were actionable have been resolved; the remaining items are
low-priority nits.

### 12.1 Resolved in this pass

| Item | Resolution |
|------|------------|
| `components/search-bar.tsx` | **Removed.** It was orphaned after the `/search` route and header search link were removed. |
| `components/__tests__/search-bar.test.tsx` | **Removed** alongside the component (test count dropped from 313/16 to 308/15). |
| `lib/ocr-cli.mjs` | **Removed.** It had zero references; OCR runs through `lib/ocr-pdf.mjs`. |
| `app/api/games/[slug]/complexity/route.ts` | **Removed.** It had no caller; complexity is generated by `digest-rulebook.mjs` and the rulebook `reDigest` flow. |
| `UNSLOTH_URL` vs `UNSLOTH_BASE_URL` | **Fixed.** `app/api/find-game/route.ts` now reads `UNSLOTH_BASE_URL` (the only other offender, the complexity route, was removed). All modules now agree. |
| Documentation drift | **Fixed.** `README.md` was corrected and `PLAN.MD` is marked historical. |

### 12.2 Remaining minor / nits

- **Unnecessarily exported symbols** (used only within their own file):
  `RULEBOOK_DESCRIPTORS`, `LANG_CODES`, `LANG_3_TO_2`, `GENERIC_DESCRIPTORS`
  (`lib/fetch-rulebook-utils.ts`) and `tokenize` (`lib/retrieve.ts`). Not dead,
  just could be non-exported.
- **No PDF virtualization by design** — large rulebooks rasterize every page at
  2× up front. Acceptable for this use case but memory-heavy for very large PDFs.
- **`getClientIp()` is a constant** (`"direct"`), so rate limits are global, not
  per-client. Fine for localhost-only; revisit behind a reverse proxy.
- **Chat history is in-memory only**; navigating away loses the conversation.
- **Intellisearch coverage:** 16/20 in a 20-game sample. The 4 failures
  (7 Wonders, Jaipur, King of Tokyo, Lords of Waterdeep) have no publicly hosted
  PDF at the time of testing — a data availability limit, not a code bug.
- **No on-demand complexity rescore endpoint** — the orphaned route was removed;
  complexity is only (re)computed during the digest / rulebook replacement. Add a
  route back if manual rescoring is ever needed.

---

## 13. Suggested next steps

1. Optionally un-export the internal-only helpers listed in §12.2.
2. Consider PDF virtualization or a page window if very large rulebooks are added.
3. Revisit per-client rate limiting if the app is ever put behind a reverse proxy
   (currently all clients share one `"direct"` bucket).
4. Intellisearch coverage is limited by data availability, not code — the four
   known misses need a hosted PDF before they can be fetched.
5. If on-demand complexity rescoring is desired, reintroduce a dedicated route
   (the previous one was removed as dead code).
