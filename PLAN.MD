> **Historical document.** This was the original project plan and is kept for
> context only. Several details have since changed (the `/search` page was
> removed, OCR is fully implemented, and chat history is in-memory only). For
> the current, authoritative description see [`README.md`](./README.md) and
> [`DOCUMENTATION.md`](./DOCUMENTATION.md).

# Board Game Catalog — Project Plan

A personal website that catalogs the board games I own. It hosts the PDF rulebooks for every game, makes all rules text searchable, and gives each game its own subpage with a picture, a description, and an AI chat bar (powered by the Unsloth provider) for asking questions about that game's rules.

**Theme:** relaxing, bookish coffee shop vibes — warm paper tones, serif typography, soft lighting, cozy and unhurried.

---

## 1. Goals & Non-Goals

### Goals
- Every owned game has a subpage: photo of the box, written description, embedded PDF rulebook viewer.
- All rulebook text is searchable site-wide; results deep-link to the specific page in the PDF.
- Each game page has a chat bar at the bottom; questions are answered by an LLM via the Unsloth provider, grounded in that game's actual rulebook text (RAG).
- Cozy "bookish coffee shop" visual identity throughout.

### Non-Goals (for v1)
- No user accounts / no multi-user content.
- No online play, scoring, or tournament features.
- No mobile app.

---

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js (App Router) + React** | Simple static-ish site with a couple of API routes; easy to iterate on. |
| Styling | **Tailwind CSS** | Fast, consistent theming via design tokens. |
| Fonts | Google Fonts: serif for headings (e.g. *Lora* / *Cormorant Garamond*), clean sans for UI text | Bookish feel with readable body copy. |
| PDF viewing | **pdfjs-dist** in an embedded viewer component | Renders the hosted PDF inline, supports deep-linking to a page via `#page=N`. |
| PDF text extraction | **pdf-parse** (Node) at build time | Pulls searchable text out of each rulebook into the search index. |
| Search | **Fuse.js** (client-side, pre-built index from extracted text) | No server/database needed for a personal catalog; instant fuzzy results as you type. (MiniSearch wasn't available in the local npm registry.) |
| Chat backend | Next.js API route → **local Unsloth server's OpenAI-compatible `/v1/chat/completions` endpoint** | Unsloth runs locally (Unsloth Studio / `unsloth run`) and exposes an authenticated OpenAI-compatible API, typically at `http://localhost:8888/v1`. Keeps the key server-side; one small route handles RAG + completion. |

> Hosting decision: **self-hosted** — `npm run build && npm start` on this machine.

---

## 3. Data Model & Content Structure

Each game lives in its own directory:

```
content/games/<slug>/
  meta.json        # title, description, image, players, playtime, etc.
  cover.jpg        # (or png) photo of the game box
  rules.pdf        # the hosted rulebook
```

`meta.json` fields:
- `title`, `slug`, `description` (a short written blurb)
- `image` (filename of cover photo)
- `pdf` (filename of rulebook)
- `players` (min–max), `playtimeMinutes`, `ageRating` *(optional, from pending idea #2)*
- `tags` (e.g., "strategy", "family", "cooperative")

A build script (`scripts/build-index.mjs`) reads every `meta.json`, extracts text from each `rules.pdf`, chunks it per page, and emits:
- `public/search-index.json` — the MiniSearch index (game slug, title, per-page text).
- Regenerates on demand via `npm run build:search`.

---

## 4. Pages & Features

### 4.1 Home Page (`/`)
- Warm hero header: site name + a short tagline ("A quiet shelf of games, ready when you are.").
- **Search bar** — live search across all rulebook text and game titles/descriptions; results list shows matching snippets with page numbers.
- **Game grid** — cards with cover photo, title, one-line description; click through to the subpage.
- Filter/sort row (by title, tags) *(pending idea #3)*.

### 4.2 Game Subpage (`/games/<slug>`)
1. **Picture** of the game (cover photo, nicely framed).
2. **Description** — the written blurb plus key stats (players, playtime, age).
3. **Rules viewer** — embedded PDF viewer with page navigation and a "Download PDF" link.
4. **Chat bar pinned at the bottom** of the page:
   - Input + message history for the current conversation.
   - Each question is sent to the API route with a context window built from that game's rulebook pages (top matches for the query, plus a summary of the whole ruleset).
   - Answers cite which rulebook page(s) they came from; clicking a citation scrolls the PDF viewer to that page.
   - Graceful fallback messages when the provider is unreachable.

### 4.3 Search Results (`/search?q=...`)
- Dedicated results page (in addition to live search on home) so results are shareable/bookmarkable.

---

## 5. Chat Architecture (Unsloth Provider)

```
Browser chat bar
   └─ POST /api/chat { game: slug, question, history }
        ├─ 1. Retrieve: score the game's rulebook pages against the question
        │      (simple keyword/BM25-style scoring over the extracted chunks)
        ├─ 2. Build prompt: system message ("You are a helpful game expert.
        │      Answer only from the provided rulebook excerpts...") + top excerpts
        └─ 3. Call Unsloth chat completions (OpenAI-compatible API)
             with the API key stored in .env (never exposed to the browser)
   └─ Render streamed/returned answer with page citations
```

- Model: whatever chat model is available from the Unsloth provider (configured in `.env`, e.g. `UNSLOTH_API_KEY` — placeholder name until confirmed).
- Conversation history kept client-side per game page (no persistence in v1; see pending idea #6).

---

## 6. Visual Design — "Bookish Coffee Shop"

- **Palette:** warm cream / oat-milk background, espresso brown text, muted terracotta and sage accents, soft amber highlights.
- **Typography:** serif headings (book-like), generous line-height, relaxed spacing.
- **Texture & mood:** subtle paper-grain background, soft drop shadows on cards (like stacked books), rounded corners, warm "evening lamp" glow on hover states.
- **Micro-details:** coffee-cup loading spinner, a little steam animation on the chat bar, section dividers styled like book spines or menu-board rules.
- **Responsive:** works well on desktop and phone; chat bar stays pinned at bottom on mobile.

---

## 7. Milestones

| # | Milestone | Deliverable |
|---|---|---|
| M0 | Plan | This document (done). |
| M1 | Scaffold & content pipeline | Next.js project, Tailwind theme tokens, `content/games/` structure, PDF text-extraction + search-index build script. Add 2–3 sample games with real PDFs to prove the pipeline. |
| M2 | Home page | Hero, game grid, live search bar, `/search` results page. |
| M3 | Game subpage | Cover photo, description, stats, embedded PDF viewer with deep-linking and download link. |
| M4 | Chat bar | `/api/chat` route wired to Unsloth, RAG context building, citations that scroll the PDF viewer, pinned chat UI. |
| M5 | Polish & ship | Theme pass (textures, animations, mobile), accessibility check, deploy notes (e.g., Vercel or a self-hosted Node server). |

---

## 8. Extra Ideas — **all approved**

1. **RAG-grounded chat with page citations** ✅ built — answers only from your rulebooks and offer a "flip to p. N" button that scrolls the PDF viewer.
2. **Richer game metadata** ✅ built — players, playtime, age rating, tags shown on cards and subpages (BGG auto-fetch skipped; fields are manual).
3. **Filter & sort controls** ✅ built — by tag and title/playtime on the home grid.
4. **Dark "evening shift" mode** ✅ built — header toggle, persisted in localStorage, no flash on reload.
5. **Personal notes per game** ✅ built — editable section saved to `content/games/<slug>/notes.json` via `/api/notes`.
6. **Chat history persistence** ✅ built — conversations saved per game in `localStorage`.
7. **"Game night picker"** ✅ built — random pick button on the home page.
8. **OCR fallback** ⚠️ partial — the build script now *detects* scanned PDFs (no extractable text) and warns at build time; full OCR needs a PDF→image renderer (native canvas module) and is deferred to a follow-up.

---

## 9. Status

- [x] M0 — Plan
- [x] M1 — Scaffold + content pipeline (`scripts/build-index.mjs`, `content/games/nemesis-lockdown/` ready; awaiting the real `rules.pdf` + `cover.jpg`)
- [x] M2 — Home page (hero, grid, live search, filters/sort, game night picker, `/search?q=`)
- [x] M3 — Game subpage (cover, description/stats/tags, pdfjs-dist viewer with page deep-links + download)
- [x] M4 — Chat bar (`/api/chat` → local Unsloth `http://localhost:8888/v1`, RAG context, citations, localStorage history) — verified working end-to-end
- [ ] M5 — Polish & ship (theme pass, mobile check, docs for adding more games)

**To go live:** drop `rules.pdf` + `cover.jpg` into `content/games/nemesis-lockdown/`, add your `sk-unsloth-…` key to `.env`, then run `npm run build && npm start`.
