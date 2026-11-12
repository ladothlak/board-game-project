# UI Follow-up Plan

Deferred design-review suggestions from the `fix/ui-consistency` pass.

These items were flagged by the reviewer but intentionally left alone, either because
the change is subjective, because a documented variant already covers the case, or
because it needs a product decision. Each entry lists the current behavior, the
proposed change, the trade-off, and how to verify it.

**Status:** all items below are **not implemented**.
**Reference:** `STYLE.md` describes the current design system.

---

## 1. Card / collapsible heading size (`text-xl`)

**Priority:** Low — optional design decision
**Effort:** Small
**Files:** `components/setup-checklist.tsx`, `components/play-log.tsx`,
`components/key-concepts.tsx`, `components/notes-section.tsx`,
`components/game-night-planner.tsx`, `components/expansions.tsx`, `STYLE.md`

**Current state:** Page-level section headings use `font-serif text-2xl`
("On the shelf", "Off the shelf", "Frequently asked", "The rulebook").
Headings inside cards/collapsibles use `font-serif text-xl`. `STYLE.md` now
documents `text-xl` as the "Card / collapsible heading" size.

**Suggestion from review:** promote these six headings to `text-2xl` so every
`h2` in the app is one size.

**Proposed change (if adopted):** replace `text-xl` with `text-2xl` on those six
`h2` elements, then remove the `text-xl` row from the typography table in
`STYLE.md`.

**Trade-off:** `text-2xl` inside a compact card is visually heavy and competes
with the page title on game pages. Keeping the split (page = 2xl, card = xl)
preserves hierarchy.

**Acceptance criteria:**
- Every `h2` inside a card/collapsible uses the chosen size.
- `STYLE.md` typography table matches the code.
- No heading wraps awkwardly at 375 px width.

---

## 2. Checkbox accent color

**Priority:** Low
**Effort:** Small
**Files:** `components/setup-checklist.tsx`, `components/bulk-add.tsx`,
`components/expansions.tsx`

**Current state:** all checkboxes use `accent-terracotta`, matching the app's
existing accent color.

**Suggestion from review:** use `accent-sage`, since terracotta is now reserved
for destructive actions.

**Proposed change (if adopted):** switch every `accent-terracotta` to
`accent-sage` and add a `Checkbox` row to the STYLE.md component conventions.

**Trade-off:** sage reads as "positive/success" and avoids destructive
associations, but it weakens the existing terracotta accent language used by
ratings, links, and active chips. Checked boxes are not destructive, so either
color is defensible.

**Acceptance criteria:**
- All checkboxes share one accent color.
- The color appears in both light and dark themes with acceptable contrast.
- `STYLE.md` documents the choice.

---

## 3. Welcome toast completion wording

**Priority:** Low
**Effort:** Trivial
**Files:** `components/welcome-toast.tsx`, `STYLE.md`

**Current state:** dialogs use "Done"; the one-time welcome toast uses
"Got it".

**Suggestion from review:** standardize every completion label to "Done".

**Proposed change (if adopted):** change the toast button from "Got it" to
"Done", or add a documented "toast dismiss" label exception.

**Trade-off:** "Got it" is warmer and fits the transient, conversational toast;
"Done" is more consistent with dialogs. The toast is not a dialog, so keeping a
distinct word is reasonable.

**Acceptance criteria:**
- A documented rule exists for dialog vs toast completion labels.
- All dialogs use the same completion label.

---

## 4. Theme toggle label semantics

**Priority:** Low–Medium — accessibility/product decision
**Effort:** Small
**Files:** `components/theme-toggle.tsx`, `STYLE.md`

**Current state:** the visible label shows the current mode ("☀ Daylight" when
light, "☾ Evening" when dark). The accessible name is a stable "Evening mode"
with `aria-pressed={dark}`, so screen readers announce pressed/not pressed.

**Suggestion from review:** use a fixed label plus a state-dependent icon, or
show the action ("Switch to evening") instead of the state.

**Proposed change (if adopted):**
- Fixed visible label: "Evening mode" (or "Theme"), with icon `☾` / `☀`.
- `aria-pressed={dark}` remains.
- Add a tooltip/title such as "Toggle the evening shift".

**Trade-off:** a fixed label is unambiguous for assistive tech but less playful.
Current state labels are friendly but can be read as the action ("click Evening"
while already in evening mode).

**Acceptance criteria:**
- The button's accessible name does not change when toggled.
- The visible state and `aria-pressed` never contradict each other.
- The label remains readable in both themes.

---

## 5. Inline text actions vs ghost buttons

**Priority:** Low
**Effort:** Small–Medium
**Files:** `components/game-meta.tsx`, `components/add-game.tsx`,
`components/expansions.tsx`, `components/add-rulebook.tsx`,
`components/bulk-add.tsx`, `STYLE.md`

**Current state:** several low-emphasis actions are text buttons:
"Dismiss & try next", "Not right — try another", "Dismiss", "Start over",
"Select all found", etc. `STYLE.md` now documents a "Text / Inline Button"
variant for these.

**Suggestion from review:** either convert them to the latte ghost button style
or explicitly document the text-button variant.

**Proposed change (if adopted):** keep the documented text-button variant, but
audit each instance and convert any that are actually primary decisions (for
example the pending-PDF accept/dismiss pair) to a consistent
ghost/primary pair.

**Trade-off:** ghost buttons add visual weight and height inside dense panels;
text buttons are lighter but easier to miss. A mixed system is fine only if the
rule is explicit.

**Acceptance criteria:**
- Every inline action uses either the documented text-button or ghost style.
- No ad-hoc border/background combinations remain.
- Cancel actions in modal footers always use ghost, never text-only.

---

## 6. `GameMeta` Dismiss button styling

**Priority:** Low
**Effort:** Trivial
**Files:** `components/game-meta.tsx`

**Current state:** the suggestion chip's "Dismiss" button uses
`rounded-md border border-latte/60 ...`, which is neither the documented
text-button nor the latte ghost style.

**Suggestion from review:** fold it into one of the documented variants.

**Proposed change (if adopted):** choose either
- ghost: `rounded-md bg-latte/40 px-2 py-0.5 ...` (matches secondary), or
- text: `rounded-md px-2 py-0.5 text-cocoa hover:bg-parchment/60 ...`.

**Trade-off:** the suggestion chip is already amber-tinted and bordered, so a
bordered Dismiss button competes with the chip. The ghost variant is likely the
best fit.

**Acceptance criteria:**
- Dismiss uses a documented button variant.
- The Accept/Dismiss pair has a clear primary/secondary hierarchy.
- `STYLE.md` lists the variant used.

---

## Recommended order

1. #6 and #3 — trivial consistency wins.
2. #2 — one accent decision, applied everywhere.
3. #4 — accessibility improvement.
4. #5 — audit; may uncover more instances.
5. #1 — only if the visual hierarchy should change; otherwise keep the
   documented split.
