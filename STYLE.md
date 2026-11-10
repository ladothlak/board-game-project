# Style Reference — Board Game Parlor

A quick lookup for design tokens, component patterns, and conventions.
Keep this in sync with `app/globals.css` and the component files.

---

## Color Palette

### Daylight (light mode)

| Token | Hex | Usage |
|-------|-----|-------|
| `cream` | `#f7f1e6` | Page background |
| `parchment` | `#ede3d0` | Section backgrounds, cards (at /40–/60 opacity) |
| `espresso` | `#38291f` | Primary text, headings |
| `cocoa` | `#5f4a3a` | Secondary text, body copy |
| `latte` | `#cbb59b` | Borders, dividers, muted elements |
| `terracotta` | `#c07a56` | Primary accents, links, active states |
| `sage` | `#8a9a7d` | Success/positive accents, primary buttons |
| `amberglow` | `#dfa94f` | Highlights, ratings, warm glows |

### Evening (dark mode)

| Token | Hex | Usage |
|-------|-----|-------|
| `night` | `#171210` | Page background |
| `nightcard` | `#221b17` | Card/section backgrounds (at /60–/80 opacity) |

Dark mode text: `parchment` for primary, `latte` for secondary, `cocoa` for borders.

### Opacity Conventions

| Pattern | Light | Dark |
|---------|-------|------|
| Section background | `bg-parchment/40` | `dark:bg-nightcard/60` |
| Card background | `bg-parchment/40` or `bg-parchment/60` | `dark:bg-nightcard/60` or `dark:bg-night` |
| Frosted glass (header, chat bar) | `bg-parchment/75 backdrop-blur` | `dark:bg-nightcard/80 backdrop-blur` |
| Border | `border-latte/60` or `border-latte/70` | `dark:border-cocoa/40` or `dark:border-cocoa/50` |
| Muted text | `text-cocoa/70` | `dark:text-latte/60` |

---

## Typography

| Role | Class | Font |
|------|-------|------|
| Headings (h1–h3) | `font-serif` | Lora (serif) |
| Body text, UI | `font-sans` | Inter (sans) |
| Page title (h1) | `font-serif text-4xl tracking-wide` | — |
| Section heading (h2) | `font-serif text-2xl` or `font-serif text-lg` | — |
| Card title | `font-serif text-base` | — |
| Body copy | `text-sm` | — |
| Small/muted | `text-xs` | — |

---

## Buttons

### Primary Action (sage)

```
rounded-lg bg-sage/70 px-4 py-2 text-sm text-espresso
transition-colors hover:bg-sage disabled:opacity-50
dark:text-parchment
```

Used for: "🎲 Pick", "Ask", "Fetch", "Add expansion", submit buttons.

### Secondary / Ghost (latte)

```
rounded-lg bg-latte/40 px-4 py-2 text-sm text-cocoa
transition-colors hover:bg-terracotta/30
dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40
```

Used for: "Cancel", dismiss, non-primary actions.

### Destructive (terracotta)

```
rounded-lg bg-terracotta px-4 py-2 text-sm text-cream
transition-colors hover:bg-terracotta/90
dark:text-espresso
```

Used for: "+ Add a Game", delete confirmations.

### Icon-only (h-8 w-8)

```
flex h-8 w-8 items-center justify-center rounded-lg
bg-latte/40 text-cocoa transition-colors hover:bg-terracotta/30
dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40
```

Used for: chat header buttons (fullscreen, clear, simple mode), zoom controls.

### Chip / Tag (small)

```
rounded-full bg-sage/25 px-2 py-0.5 text-xs text-cocoa
dark:text-latte
```

Used for: game tags on cards, mood chips (active: `border-terracotta bg-terracotta/15`).

---

## Cards

### Game Card (grid)

```
relative rounded-xl border border-latte/60 bg-parchment/40 p-3 shadow-sm
transition-colors hover:border-terracotta/50
dark:border-cocoa/40 dark:bg-nightcard/60 dark:hover:border-amberglow/50
```

### Suggestion / Pair Card

```
flex min-h-[5rem] items-center gap-3 rounded-xl border border-latte/60
bg-parchment/40 p-3 shadow-sm transition-colors hover:border-terracotta/50
dark:border-cocoa/40 dark:bg-nightcard/60 dark:hover:border-amberglow/50
```

### Modal Container

```
w-full max-w-md rounded-2xl border border-latte/60 bg-parchment/90 p-6 shadow-xl
dark:border-cocoa/40 dark:bg-nightcard/95
```

With backdrop: `fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm`

### Empty State Placeholder

```
mt-4 rounded-xl border border-dashed border-latte bg-parchment/40 p-6
text-center text-cocoa
dark:border-cocoa/50 dark:bg-nightcard dark:text-latte
```

---

## Spacing Rhythm

| Context | Value |
|---------|-------|
| Between major page sections | `mt-10` |
| Between sub-sections within a section | `mt-6` |
| Between elements within a card/group | `mt-4` |
| Tight grouping (label → input, title → body) | `mt-2` or `mt-3` |
| Inline gap (flex items) | `gap-2`, `gap-3`, `gap-4` |
| Page horizontal padding | `px-4` |
| Max content width | `max-w-4xl` (game page), `max-w-5xl` (home) |

---

## Borders & Shadows

| Element | Border | Shadow |
|---------|--------|--------|
| Cards | `border-latte/60` / `dark:border-cocoa/40` | `shadow-sm` |
| Modals | `border-latte/60` / `dark:border-cocoa/40` | `shadow-xl` |
| Inputs | `border-latte/70` / `dark:border-cocoa/50` | none |
| Header/Footer | `border-b border-latte/50` / `dark:border-cocoa/30` | none |
| PDF pages | none (canvas) | `shadow-md` on each page canvas |

---

## Animations

| Class | Effect | Duration |
|-------|--------|----------|
| `fade-up` | Opacity 0→1 + translateY 6px→0 | 400ms ease-out |
| `.steam span` | Coffee steam rise (3 staggered puffs) | 1.8s infinite loop |
| Hover lift | `translate-y-[-2px]` + shadow increase | 200ms transition |
| Color transitions | `transition-colors duration-200` | 200ms |
| Transform transitions | `transition-transform duration-300 ease-out` | 300ms |

---

## Layout Patterns

### Page Structure (game subpage)

```
CoverTint wrapper
  └─ max-w-4xl px-4 py-10
       ├─ Back link
       ├─ Cover image (h-96, rounded-2xl)
       ├─ Title + GameMeta + Description + Rating
       ├─ FAQ (2×2 grid)
       ├─ ChatBar (inline section)
       ├─ PDF Viewer (+ EditRulebook)
       ├─ Expansions (collapsible)
       └─ BelowFold (lazy: KeyConcepts, Checklist, Notes, PlayLog, PairsWith, SimilarGames)
```

### Home Page Structure

```
Hero section
  └─ GameFinder (natural language search)
ShelfSection (3 buttons on one line: Find / Pick / Add)
  └─ GameGrid (cards with sort dropdown)
GameNightPlanner (below fold)
HiddenGames ("Off the shelf")
Footer (HealthStrip + tagline)
```

### Modal Pattern

```
<button onClick={open}>Trigger</button>
{open && (
  <div className="fixed inset-0 z-50 ... backdrop" onClick={closeIfBackdrop}>
    <div className="w-full max-w-md rounded-2xl ...">
      <h3>Title</h3>
      <p>Subtitle</p>
      ...form content...
      <div className="mt-4 flex items-center gap-2">
        <button primary>Action</button>
        <button secondary>Cancel</button>
      </div>
      {result && <ResultCard />}
    </div>
  </div>
)}
```

---

## Component Conventions

| Convention | Detail |
|------------|--------|
| Client components | All interactive UI is `"use client"` |
| Server components | Pages, layout, data fetching |
| Lazy loading | Below-fold sections use `next/dynamic` + `ssr: false` |
| Images | `next/image` with `fill` + `sizes` for covers; `<img>` for small thumbnails in cards |
| API calls | `fetch()` with error handling; never expose raw errors to user |
| State | Local `useState`; no global state library |
| Routing | `next/link` for navigation; `router.refresh()` after mutations |
| Forms | Manual validation (no `required` attribute); `noValidate` on `<form>` |
| File uploads | `FormData` + `fetch`; track file in state, not just ref |

---

## Voice & Tone

- Warm, slightly playful, never corporate.
- "The parlor suggests…" not "System recommendation:…"
- "Brewing…" not "Loading…"
- "The barista is taking a break" not "Server error"
- Emojis are functional (☕ 🎲 🔍 ⚔️ 🤝 🧠 🪶), not decorative filler.
- Short sentences. Contractions OK ("I'll", "don't").

---

## Do / Don't

| Do | Don't |
|----|-------|
| Use token colors (`text-espresso`, `bg-parchment/40`) | Use raw hex values in className |
| Use `dark:` variants for every color | Assume light mode only |
| Keep transitions at 200ms (color) / 300ms (transform) | Mix durations within one interaction |
| Use `rounded-xl` for cards, `rounded-2xl` for modals | Use `rounded-lg` for large containers |
| Show brewing steam for all LLM waits | Show a bare spinner |
| Keep empty states as dashed-border placeholders | Leave blank space where content should be |
| Add `aria-label` to icon-only buttons | Ship unlabeled icon buttons |
