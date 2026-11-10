# Board Game Parlor

A cozy, self-hosted catalog of board games. Every game gets its own page with a cover photo, description, an embedded rulebook PDF viewer, and a chat bar that answers questions about the rules — grounded in the actual rulebook text (RAG) via a local [Unsloth](https://unsloth.ai/docs/basics/api.md) LLM server.

Theme: relaxing, bookish coffee shop. ☕

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 15 (App Router) + React 19 |
| Styling | Tailwind CSS 4 (CSS-based config, no `tailwind.config.js`) |
| Language | TypeScript (strict mode) |
| PDF rendering | pdfjs-dist (client-side) |
| Chat rendering | react-markdown + remark-gfm |
| Search | fuse.js (client) + TF-IDF (server) |
| LLM | Local Unsloth server (OpenAI-compatible API) |
| PDF extraction | pdfjs-dist legacy Node build (child process) |
| OCR fallback | ghostscript (`gs`) + tesseract |
| Cover rendering | ghostscript (`gs -sDEVICE=jpeg`) |
| PWA | Service worker + manifest (offline caching) |

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **ghostscript** (`gs`) — for PDF text extraction and cover rendering
- **tesseract** — optional, for OCR of scanned/image-only PDFs
- **Unsloth server** running locally (or a compatible OpenAI API endpoint)

### Install & Run

```bash
npm install
npm run build   # extracts rulebook text into the search index + builds the site
npm start       # serves on http://localhost:3111
```

For development: `npm run dev`.

### Configure the LLM

Copy `.env.example` to `.env` and fill in:

- `UNSLOTH_API_KEY` — your API key.
- `UNSLOTH_BASE_URL` — e.g. `http://localhost:8888/v1`.
- `UNSLOTH_MODEL` — the loaded model ID, e.g. `ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF`.

Verify connectivity:

```bash
curl $UNSLOTH_BASE_URL/models -H "Authorization: Bearer $UNSLOTH_API_KEY"
```

### Optional: Auth for Personal Data

Set `PARLOR_AUTH_TOKEN` in `.env` to protect personal-data endpoints (notes, ratings, play logs, bookmarks). If unset, these endpoints are open (localhost-only).

---

## Features

### Game Pages

Each game subpage (`/games/<slug>`) includes:

- **Cover photo** — rendered from the rulebook's first page via ghostscript if no cover is provided.
- **Description** — LLM-generated "lore-first" blurb, persisted in `meta.json`.
- **Metadata** — players, playtime, age rating, tags, complexity score (1–5 dots).
- **Personal rating** — 1–5 star widget.
- **FAQ section** — a 2×2 grid of starter questions above the chat.
- **Chat bar** — inline (not sticky), placed just above the rulebook.
- **PDF viewer** — full-featured rulebook reader (see below).
- **Expansions** — collapsible section for managing expansion rulebooks.
- **Key Gameplay Concepts** — LLM-generated index of major rulebook elements with page links.
- **Setup checklist** — collapsible, on-demand tick-off list with a setup timer.
- **"If you liked this, try…"** — uniform-sized suggestion cards.
- **Game night log** — "🎲 We played this" button.
- **Edit Rulebook** — replace the PDF and trigger a full LLM content refresh.

### PDF Viewer

- **Discrete zoom levels** — 100% / 150% / 200% via instant CSS scaling (no re-rasterization).
- **Current page tracking** — as you scroll, the viewer knows which page you're on.
- **Bookmarks** — save labelled pages; jump to them from chips above the viewer.
- **"Ask about p. N"** — sends a focused question to the chat bar for the current page.
- **TOC drawer** — per-page table of contents with LLM-generated labels.
- **Theme cycling** — normal / sepia / dark reading themes.
- **Shareable page links** — "🔗 Copy link" generates a URL that jumps to a specific page.
- **Jump-to-page** — centers the target page with a ~100ms gradual scroll; skips if already visible.
- **Fullscreen toggle**.
- **Expansions appended** — enabled expansion PDFs are rendered sequentially after the base rulebook.

### Chat (Grounded RAG)

The chat is powered by a multi-stage retrieval pipeline (`lib/rag.ts`):

1. **Query-type classification** — detects question type (rule lookup, setup, comparison, etc.).
2. **Explicit page detection** — "Tell me about page 14" goes straight to that page.
3. **LLM query expansion** — generates search variants (skipped for short/page-specific queries).
4. **Multi-query TF-IDF retrieval** — top 8 candidates across all queries.
5. **Page boost** — explicitly-referenced pages are force-included.
6. **Expansion boost** — if the query mentions an enabled expansion by name, its chunks are boosted to the top.
7. **LLM re-ranking** — candidates scored for relevance.
8. **Cross-reference following** — pulls pages referenced by retrieved chunks.
9. **Adaptive context budget** — allocates tokens proportionally to relevance.
10. **Confidence estimate** — flags weak matches so the model says "I'm not sure" instead of hallucinating.
11. **Hierarchical TOC** — a per-page map is always included for orientation.

Additional chat features:

- **SSE streaming** — tokens arrive word-by-word over Server-Sent Events.
- **Markdown + GFM tables** — answers render as formatted markdown.
- **Clickable citations** — in-text page references and pill buttons below the message; all formats captured, sorted ascending.
- **Fullscreen toggle**.
- **Simple mode** — plain-language answers for new players.
- **Cross-game comparison** — optional second game context.
- **Speculative prewarm** — a 60s-TTL in-memory cache avoids redundant RAG calls.
- **Expansion awareness** — the system prompt mentions enabled expansions and their page ranges.

### Home Page

- **Hero section** with site name and tagline.
- **"Find a Game" modal** — LLM-based natural language search: type a description, click "Ask", get up to 3 recommended games with reasons. Two-stage pipeline (keyword pre-filter → LLM ranking).
- **"Pick a Game" modal** — enter player count and/or max minutes for a scored recommendation.
- **"+ Add a Game"** button — opens the add-game modal.
- **Game grid** — cards with cover, title, tags, complexity dots, and rating. Sort dropdown (title, rating, recently played).
- **Saved searches** — auto-saved after each successful find; one-tap chips for reuse.
- **Game night planner** — below the fold.
- **"Off the shelf"** — hidden games with restore buttons.
- **HealthStrip** — AI status, game count, index date (polled every 30s).

### Add-a-Game Workflow

The modal offers three rulebook source methods:

1. **Intellisearch** (default) — type a name, click 🔍 to look up metadata from Wikipedia/BGG/web. The system auto-fills description, players, playtime, age, tags, and publisher. Then it attempts to find the rulebook PDF via a 4-strategy pipeline:
   - Known cache + static dictionary + publisher patterns
   - Publisher base URL probe (learned directory structure)
   - Targeted web search (domain-scoped if known)
   - Publisher site scan
   
   Found URLs are shown for user verification before accepting. Dismiss-and-retry (up to 3 follow-ups) with excluded URLs.

2. **Link** — paste a direct PDF URL and click "Fetch". The PDF is downloaded and shown for confirmation.

3. **Manual** — drag-and-drop a PDF and cover image into the modal.

All methods support:
- Base-game validation (rejects expansion/sequel URLs when a base game is requested).
- Cover auto-rendering from the rulebook's first page if no cover is provided.
- Background LLM digest on submit (description, metadata fill, search index refresh).

### Expansions

- Added via the same modal pattern as add-game (Intellisearch / Link / Manual).
- Each expansion has a **chat context toggle** — when enabled, its PDF text is extracted and added to the search index under the parent game's slug (so RAG picks it up automatically).
- Expansion page numbers are offset after the base game's last page to avoid collisions.
- Enabled expansions are appended to the PDF viewer as a continuous document.
- The chat system prompt mentions enabled expansions by name.
- Chunk IDs use the prefix `${slug}-exp-${nameSlug}` for identification and cleanup.

### Security

| Feature | Implementation |
|---------|---------------|
| Rate limiting | In-memory per-IP: chat 10/min, find-game 5/min, lookup 5/min, fetch-rulebook 5/min, upload 3/min |
| Input caps | 1000 chars (chat), 500 chars (finder) |
| Prompt-injection guard | `lib/guard.ts` — strips/flags injection patterns in user input |
| Single-flight LLM queue | `lib/llm-queue.ts` — serializes concurrent LLM calls |
| Request timeout | All LLM calls have a timeout |
| Security headers | `middleware.ts` — X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy |
| Body-size limit | 100 KB (upload routes exempted for PDF uploads) |
| Optional auth | Bearer-token via `PARLOR_AUTH_TOKEN` env var |
| Audit logging | `logs/audit.log` — one JSON line per API call |

### Performance

- **Preconnect** to the LLM endpoint in `<head>`.
- **PDF file route** sends ETag + `Cache-Control: public, max-age=86400`.
- **Game metadata** cached in memory with 30s TTL (`invalidateGamesCache()`).
- **Below-fold sections** lazy-loaded via `BelowFold` client component (`next/dynamic` + `ssr: false`).
- **`next/image`** for covers/thumbnails.
- **Service worker** stale-while-revalidate for API GETs.
- **RAG optimization** — skips LLM expansion for queries < 20 chars or with explicit pages.
- **Speculative RAG prewarm** endpoint with 60s TTL cache.
- **Game Finder cache** — in-memory Map, 200 entry cap, fingerprint-invalidated on shelf change.

### PWA

- `public/manifest.json` — standalone display, theme color `#8b5e3c`.
- `public/sw.js` — caches same-origin GET responses with stale-while-revalidate for API routes.
- Installable as a mobile app; works offline for previously-visited pages.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus chat input |
| `Ctrl+K` | Focus search bar |

### Onboarding

First-visit welcome toast (localStorage-gated) introduces the site's features.

---

## Project Structure

```
app/
  layout.tsx              Root layout: fonts, header, HealthStrip, PWA, SW registration
  page.tsx                Home: hero, GameFinder, ShelfSection, GameNightPlanner, HiddenGames
  search/page.tsx          /search?q=… text results and /search?tag=… tag lists
  games/[slug]/page.tsx    Game subpage: cover, description, FAQ, chat, PDF viewer, expansions
  api/
    chat/route.ts          Enhanced RAG → streaming SSE chat
    chat/prewarm/route.ts  Speculative RAG prewarm (60s TTL)
    find-game/route.ts     LLM game recommendations (two-stage pipeline)
    health/route.ts        Provider/index/shelf status probe
    games/route.ts         POST — add a game (PDF upload)
    games/lookup/route.ts  Game metadata lookup (Wikipedia → BGG → web search)
    games/fetch-rulebook/  4-strategy rulebook PDF fetch + persistent cache
    games/[slug]/route.ts  GET single game
    games/[slug]/file/     Serve cover/PDF on demand from content/games/<slug>/
    games/[slug]/rulebook/ Replace rulebook + full re-digest pipeline
    games/[slug]/expansions/  POST/DELETE/PATCH expansion management
    games/[slug]/checklist/   Setup checklist (LLM-generated)
    games/[slug]/concepts/    Key gameplay concepts (LLM-generated)
    games/[slug]/complexity/  LLM-estimated 1–5 complexity score
    games/[slug]/rating/      1–5 star rating
    games/[slug]/bookmarks/   PDF page bookmarks
    games/[slug]/plays/       Play log
    games/[slug]/notes/       Personal notes
    games/[slug]/toc/         Per-page TOC labels
    games/[slug]/suggestions/ Accept/dismiss metadata suggestions
    games/[slug]/remove/      Hide / restore / delete
    games/visible/             Slugs currently on the shelf
    notes/route.ts           Personal notes (aggregate)
    plays/route.ts             Aggregate last-played per game

components/               32 client components
  add-game.tsx            Add-game modal (Intellisearch/Link/Manual)
  expansions.tsx          Expansion management UI + modal
  pdf-viewer.tsx          PDF viewer (zoom, bookmarks, TOC, themes, jump)
  chat-bar.tsx            Streaming RAG chat with citations
  game-finder.tsx         LLM-based natural language game search
  find-game-modal.tsx     "Find a Game" modal
  game-night-picker.tsx   Player/time-based recommendation
  setup-checklist.tsx     Collapsible tick-off list + timer
  key-concepts.tsx        LLM-generated rulebook index
  edit-rulebook.tsx       Replace PDF + re-digest trigger
  search-bar.tsx          Client-side fuse.js search
  game-grid.tsx           Game card grid with sort
  shelf-section.tsx       Three-button row (Find / Pick / Add)
  health-strip.tsx         AI status + game count + index date
  faq.tsx                 2×2 starter questions grid
  below-fold.tsx          Lazy-loading wrapper (ssr: false)
  welcome-toast.tsx       First-visit onboarding
  keyboard-shortcuts.tsx  / and Ctrl+K handlers
  theme-toggle.tsx        ☾ Evening / ☀ Daylight toggle
  cover-tint.tsx          Sets --tint-rgb CSS variable for header/footer
  saved-searches.tsx      One-tap chips for reused searches
  similar-games.tsx       "If you liked this, try…" cards
  rating.tsx              1–5 star widget
  play-log.tsx            "🎲 We played this" button
  notes-section.tsx       Personal notes editor
  remove-game.tsx         Hide / delete modal
  hidden-games.tsx        "Off the shelf" section
  game-meta.tsx           Players/playtime/age/tags display
  description-block.tsx   LLM-generated description with "brewing" state
  faq.tsx                 FAQ grid
  theme-toggle.tsx        Dark mode toggle

lib/                      Server-side utilities
  games.ts                GameMeta interface, listGames/getGame (30s TTL cache)
  rag.ts                  Enhanced RAG pipeline (11 stages)
  retrieve.ts             TF-IDF retrieval + sanitizeChunkText()
  generate-checklist.ts   LLM setup checklist generation
  generate-concepts.ts    LLM key concepts generation
  llm-queue.ts            Single-flight LLM call serialization
  rate-limit.ts           In-memory per-IP rate limiter
  guard.ts                Prompt-injection guard
  auth.ts                 Optional bearer-token auth
  audit-log.ts            JSON-lines API request logger

content/
  known-rulebooks.json    Persistent cache: game name → URL, publisher → baseUrl
  games/<slug>/           One folder per game:
    meta.json             Title, description, image, pdf, players, tags, expansions
    cover.jpg             Cover photo (or auto-rendered from PDF)
    rules.pdf             Rulebook PDF
    checklist.json        Setup checklist (runtime)
    concepts.json         Key concepts (runtime)
    rating.json           Personal rating (runtime)
    bookmarks.json        PDF bookmarks (runtime)
    plays.json            Play log (runtime)
    notes.json            Personal notes (runtime)

public/
  search-index.json       Build-time TF-IDF index (per-page chunks)
  manifest.json           PWA manifest
  sw.js                   Service worker (offline caching)

scripts/
  build-index.mjs         PDF text extraction → search index (+ OCR fallback)
  backup.mjs              Tar content/games + index into backups/

logs/
  audit.log               JSON-lines API request log (gitignored)
```

---

## Data Model

### `meta.json` (per game)

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
  "expansions": [
    {
      "name": "Voidseeders",
      "pdf": "expansion-voidseeders.pdf",
      "inChatContext": true
    }
  ]
}
```

### Search Index Entry

```json
{
  "id": "nemesis-lockdown-exp-voidseeders-p4",
  "slug": "nemesis-lockdown",
  "title": "Nemesis: Lockdown",
  "page": 36,
  "text": "INSANITY SYSTEM In the Void Seeders expansion, Characters ma..."
}
```

Expansion chunks use the **parent game's slug** so RAG's `filter(c => c.slug === slug)` picks them up automatically. Page numbers are offset after the base game's last page.

---

## Adding a Game (Manual)

1. Create `content/games/<slug>/`.
2. Add `meta.json` (see data model above).
3. Drop `cover.jpg` and `rules.pdf` into the folder.
4. Run `npm run build:search` — extracts rulebook text page-by-page into `public/search-index.json`.

Notes:
- Scanned/image-only PDFs are handled via OCR fallback (ghostscript → PNG → tesseract).
- Cover images and rulebook PDFs are served on demand via `/api/games/[slug]/file?name=…` (not copied to `public/`).
- Chat conversations are in-memory only; navigating away starts a fresh chat.

---

## Removing a Game

Each card has a **×** button:

- **Remove from shelf** — sets `hidden: true`; game moves to "Off the shelf" with a Restore button. Filtered out of search.
- **Delete everything** — permanently removes `content/games/<slug>/`. Cannot be undone.

---

## Backup

```bash
npm run backup
```

Writes a timestamped tarball to `backups/` and prunes everything older than the 10 most recent archives. Run regularly — "Delete everything" is not undoable.

---

## Design Notes

### Visual Theme

- **Light mode ("Daylight")**: warm cream, parchment, espresso, cocoa, latte, terracotta, sage, amberglow.
- **Dark mode ("Evening shift")**: deep night and nightcard tones.
- **Fonts**: Lora (serif, headings) + Inter (sans, body).
- **Paper-grain SVG overlay** for texture.
- **Lamp-glow radial gradients** for ambient warmth.
- **Brewing steam animation** in all loading states.
- All game page sections use `bg-parchment/40` + `dark:bg-nightcard/60` tinted backgrounds.
- Chat bar and sticky header use `bg-parchment/75` + `dark:bg-nightcard/80` with backdrop blur (frosted glass).

### Layout Principles

- Chat bar is a plain inline element (not sticky/fixed), placed in its own section just above the rulebook on all devices.
- FAQ is a 2×2 grid, positioned above the chat section.
- Homepage buttons ("Find a Game", "Pick a Game", "+ Add a Game") are on one line in that order.
- "If you liked this, try…" cards are uniform size.
- Header font: `text-base sm:text-xl` for mobile one-line fit.

### LLM Usage

The local model is a **reasoning model** — it can return empty content, so:
- Chat has an empty-answer fallback.
- Digest retries 3×.
- Complexity score uses `max_tokens: 10`, `temperature: 0.2`; falls back to 3 if parseInt fails.
- Find-game requests take ~9–10s on first call; cached calls are instant.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `UNSLOTH_API_KEY` | Yes | API key for the LLM server |
| `UNSLOTH_BASE_URL` | Yes | e.g. `http://localhost:8888/v1` |
| `UNSLOTH_MODEL` | Yes | Model ID (e.g. `ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF`) |
| `PARLOR_AUTH_TOKEN` | No | Bearer token to protect personal-data endpoints |

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development server (hot reload) |
| `npm run build` | Build search index + production build |
| `npm start` | Production server on port 3111 |
| `npm run build:search` | Extract PDF text → `public/search-index.json` |
| `npm run backup` | Tar `content/games/` + index into `backups/` |

---

## When Things Go Wrong

### The LLM server is down

The chat bar, game finder, and all LLM-generated content (descriptions,
concepts, checklists) depend on the Unsloth server at `UNSLOTH_BASE_URL`.
If it's unreachable:

- The HealthStrip in the footer shows a red dot ("parlor AI offline").
- Chat requests return an error message with the brewing animation.
- Existing cached content (descriptions, concepts) still loads fine —
  only *new* generation fails.

**Fix:** Start the Unsloth server (`unsloth` CLI) and confirm it's listening
on port 8888. The HealthStrip polls every 30 s and will flip back to green
automatically.

### PDF extraction fails

The rulebook digest spawns a child process (`lib/extract-cli.mjs`) that uses
`pdfjs-dist`. If it crashes:

- Check that the PDF file is valid (`file content/games/<slug>/rules.pdf`).
- Look for OCR fallback errors in the server console — `tesseract` must be
  installed for scanned PDFs.
- Re-run the digest: `POST /api/games/[slug]/rulebook` with the same PDF.

### Port conflict

The production server runs on port 3111. If something else is already using
it:

```bash
lsof -i :3111   # find the offending process
kill <pid>      # or change the port in package.json
```

### Disk full

The `content/` directory stores PDFs (tens of MB each), rendered covers, and
the search index. If the disk fills up:

- Check usage: `du -sh content/games/`
- Remove games you no longer need: `DELETE /api/games/[slug]/remove`
- Clear old backups: `ls backups/ | tail -n +11 | xargs rm` (keeps 10 most recent)

### Checking the audit log

Every API call is logged as a JSON line to `logs/audit.log` (gitignored).
To inspect recent activity:

```bash
tail -20 logs/audit.log | jq .
# Filter by route:
grep '"route":"/api/chat"' logs/audit.log | tail -10
```

### Search index is stale

If a game was added or its rulebook replaced but chat doesn't see the new
content:

- The re-digest pipeline rewrites `public/search-index.json` automatically.
- Check for a `.digesting` marker file in `content/games/<slug>/` — its
  presence means the background digest is still running.
- As a last resort, delete `public/search-index.json` and restart the server;
  it will be rebuilt from all game PDFs on next request.
