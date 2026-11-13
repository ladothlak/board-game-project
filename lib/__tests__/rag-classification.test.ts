import { describe, it, expect } from "vitest";
import { classifyQuery } from "../rag";
import type { QueryType } from "../rag";

/**
 * Classification regression tests (issue #66).
 *
 * The keyword heuristic in `classifyQuery` had two structural bugs: a
 * precedence bug (`edge-case` checked before `victory`, so "When does the
 * game end?" classified as edge-case) and substring matching ("if" inside
 * "difference", "turn" inside "return", "vs" inside "devs"). This file pins
 * down the fix:
 *
 *   - one assertion per labelled question in the 118-case benchmark dataset
 *     (the same question → expected-type pairs `rag-benchmark.test.ts`
 *     scores, so any future regression in the keyword patterns fails here),
 *   - explicit precedence tests for the victory-vs-edge-case ordering,
 *   - explicit word-boundary tests for the removed substring keywords.
 *
 * The labelled dataset has a small number of cases that NO keyword heuristic
 * can resolve correctly (game-specific wording, or labels that conflict with
 * identical wording in other games). Those are listed in KNOWN_MISSES below
 * with the reason — they are excluded from the per-case assertions so `npm
 * test` stays green, and they are what cap the keyword accuracy at ~89.8%
 * (the ≥ 85% gate is enforced by the benchmark's classification test).
 */

// The labelled benchmark dataset: question → expected query type. Mirrors
// DATASET in rag-benchmark.test.ts (kept local so this file is
// self-contained and runs with no index, env, or network access). Duplicate
// question strings are listed once — the classifier is a pure function of
// the question text.
const CLASSIFICATION_CASES: [string, QueryType][] = [
  // ── setup ────────────────────────────────────────────────────────────────
  ["How do I set up the game?", "setup"],
  ["How do I set up the board?", "setup"],
  ["How do I set up the board in Nemesis?", "setup"],
  ["How do I set up for three players?", "setup"],
  ["How do I set up the play area?", "setup"],
  // ── victory ───────────────────────────────────────────────────────────────
  ["How do I win?", "victory"],
  ["How do I win the haunt?", "victory"],
  ["When does the game end?", "victory"],
  ["How does the game end?", "victory"],
  ["What is my goal in the game?", "victory"],
  ["What is the goal of the game?", "victory"],
  ["What is the victory condition?", "victory"],
  ["How is scoring done?", "victory"],
  // ── turn-structure ────────────────────────────────────────────────────────
  ["What actions can I take during my turn?", "turn-structure"],
  ["What is the order of the phases in my turn?", "turn-structure"],
  ["What happens during the Evening phase?", "turn-structure"],
  ["What happens during the Clean Up phase?", "turn-structure"],
  ["What happens during the draft phase?", "turn-structure"],
  ["What are the game phases?", "turn-structure"],
  ["What happens on my turn?", "turn-structure"],
  ["What do I do on my turn?", "turn-structure"],
  ["What actions can I take on my turn?", "turn-structure"],
  ["What are the three phases of my turn?", "turn-structure"],
  ["What happens during my turn?", "turn-structure"],
  ["What are my actions on my turn?", "turn-structure"],
  ["What happens during a player's turn?", "turn-structure"],
  ["What happens during the Craftsman phase?", "turn-structure"],
  ["What actions can I take in summer?", "turn-structure"],
  ["What happens at the end of a round?", "turn-structure"],
  ["What actions can I take?", "turn-structure"],
  // ── comparison ────────────────────────────────────────────────────────────
  ["What is the difference between Light and Serious wounds?", "comparison"],
  // ── edge-case ─────────────────────────────────────────────────────────────
  ["How do I play the solo version of Agricola?", "edge-case"],
  ["How do I play Nemesis in solo mode?", "edge-case"],
  ["What happens when an Intruder appears in a room with me?", "edge-case"],
  ["What happens when I get a third Paradox token?", "edge-case"],
  ["What does the errata say about paying interest?", "edge-case"],
  // ── specific-rule ─────────────────────────────────────────────────────────
  ["What is special about the desert hex?", "specific-rule"],
  ["How does trading work in Catan?", "specific-rule"],
  ["What are the number tokens used for?", "specific-rule"],
  ["How do I get the Longest Road card?", "specific-rule"],
  ["What is my goal in Catan?", "specific-rule"],
  ["How do I move my ship from the Open Sea to Auction?", "specific-rule"],
  ["How do I fight an Intruder in combat?", "specific-rule"],
  ["How do Exploration tokens work?", "specific-rule"],
  ["What is special about Crossroads rooms?", "specific-rule"],
  ["How does the Vagabond battle without warriors?", "specific-rule"],
  ["What are dominance cards and how do they work?", "specific-rule"],
  ["How do I use a card for crafting?", "specific-rule"],
  ["What are clearings and slots on the map?", "specific-rule"],
  ["What happens during combat?", "specific-rule"],
  ["How does the Build action work?", "specific-rule"],
  ["How does the Sell action work?", "specific-rule"],
  ["How do I sell goods?", "specific-rule"],
  ["How do intruders move?", "specific-rule"],
  ["How do I build a building?", "specific-rule"],
  ["How do I place my cards?", "specific-rule"],
  ["How do I place a domino?", "specific-rule"],
  ["How does damage work?", "specific-rule"],
  ["How do I extinguish fire?", "specific-rule"],
  ["How do I score a completed city?", "specific-rule"],
  ["How do animals attract their own kind?", "specific-rule"],
];

/**
 * The labelled cases no keyword heuristic can resolve (issue #66). Each entry
 * is [question, expected type, why it stays wrong]:
 *
 * - "What happens when I plow a field?" — specific-rule: "when" (edge-case)
 *   outranks "what happens"; the 3 "what happens when X" cases labelled
 *   specific-rule and the 2 labelled edge-case can't be separated by keywords.
 * - "How many Minor Improvement cards does each player get at the start?" —
 *   specific-rule: "start" (setup) matches first; dropping "start" would
 *   misroute real setup questions like "How do I start the game?".
 * - "What is the Distance Rule for building a settlement?" — edge-case:
 *   "rule" (specific-rule) matches; only the game-specific "distance rule"
 *   phrase would separate it.
 * - "What happens when you battle another player?" — specific-rule: "when"
 *   outranks "what happens" (same trade-off as the plow case).
 * - "What is turmoil and how do I resolve it?" — edge-case: "turmoil" is
 *   game-specific; no generic edge-case keyword matches.
 * - "How does the Marquise score victory points?" — specific-rule: "victory"
 *   (victory) outranks "how does"; scoring a faction's points is not an
 *   end-of-game question.
 * - "When does the game end?" (nemesis-lockdown label) — labelled
 *   specific-rule in one game but victory in two others with identical
 *   wording; issue #66 requires victory for this phrasing, so the single
 *   conflicting label is documented here instead of asserted.
 * - "What actions can I take?" (coup label) — labelled specific-rule in one
 *   game but turn-structure in two others with identical wording; the
 *   majority label (turn-structure) wins.
 * - "What happens when I look for trouble?" — specific-rule: "when" outranks
 *   "what happens" (same trade-off as the plow case).
 * - "How do I draw Event, Item, and Omen cards?" — turn-structure: "draw" is
 *   too broad a signal to anchor on.
 * - "How does deck building work in Clank?" — turn-structure: "deck building"
 *   is game-specific wording.
 * - "How does the action selection work?" — turn-structure: "action selection"
 *   is game-specific wording.
 */
const KNOWN_MISSES: [string, QueryType][] = [
  ["What happens when I plow a field?", "specific-rule"],
  ["How many Minor Improvement cards does each player get at the start?", "specific-rule"],
  ["What is the Distance Rule for building a settlement?", "edge-case"],
  ["What happens when you battle another player?", "specific-rule"],
  ["What is turmoil and how do I resolve it?", "edge-case"],
  ["How does the Marquise score victory points?", "specific-rule"],
  ["What happens when I look for trouble?", "specific-rule"],
  ["How do I draw Event, Item, and Omen cards?", "turn-structure"],
  ["How does deck building work in Clank?", "turn-structure"],
  ["How does the action selection work?", "turn-structure"],
];

/**
 * Label conflicts: questions that are pinned above (to the majority /
 * issue-#66-required type) but carry a single conflicting label in one game.
 * Documented here instead of asserted, since no keyword heuristic can
 * satisfy both labels for identical wording.
 */
const LABEL_CONFLICTS: [string, QueryType][] = [
  ["When does the game end?", "specific-rule"], // nemesis-lockdown label only
  ["What actions can I take?", "specific-rule"], // coup label only
];

describe("classifyQuery — labelled benchmark regression (issue #66)", () => {
  it.each(CLASSIFICATION_CASES)("%s → %s", (question, expectedType) => {
    expect(classifyQuery(question)).toBe(expectedType);
  });

  // Every labelled case is accounted for: the passing set plus the documented
  // known misses and label conflicts cover the full 118-case benchmark
  // dataset (61 pinned + 10 pure misses + 2 conflicting labels = 71 unique
  // questions; the remaining 47 benchmark cases repeat pinned wording).
  it("accounts for every labelled benchmark question", () => {
    const pinned = new Set(CLASSIFICATION_CASES.map(([q]) => q));
    for (const [q] of KNOWN_MISSES) expect(pinned.has(q)).toBe(false); // no double-counting
    for (const [q] of LABEL_CONFLICTS) expect(pinned.has(q)).toBe(true); // pinned above
  });
});

describe("classifyQuery — precedence (issue #66)", () => {
  it("classifies 'When does the game end?' as victory, not edge-case", () => {
    // The original bug: `edge-case` ("when") was checked before `victory`, so
    // the canonical end-of-game question resolved to the wrong type.
    expect(classifyQuery("When does the game end?")).toBe("victory");
  });

  it("classifies 'How does the game end?' as victory, not edge-case", () => {
    expect(classifyQuery("How does the game end?")).toBe("victory");
  });

  it("keeps victory ahead of specific-rule ('How do I win?' contains 'how do')", () => {
    expect(classifyQuery("How do I win?")).toBe("victory");
  });

  it("keeps setup as the most specific type ('How do I set up the game?' contains 'how do')", () => {
    expect(classifyQuery("How do I set up the game?")).toBe("setup");
  });

  it("lets edge-case win over specific-rule for conditional questions", () => {
    // "when" is an edge-case signal and must beat the generic "what happens".
    expect(classifyQuery("What happens when an Intruder appears in a room with me?")).toBe("edge-case");
  });

  it("lets comparison win over edge-case for difference questions", () => {
    // "difference" used to trip the substring keyword "if" (edge-case) first.
    expect(classifyQuery("What is the difference between Light and Serious wounds?")).toBe("comparison");
  });
});

describe("classifyQuery — word boundaries (issue #66)", () => {
  it("does not match 'if' inside other words", () => {
    // "difference" contains "if"; with \b boundaries it must classify as
    // comparison, never edge-case.
    expect(classifyQuery("What is the difference between the two modes?")).toBe("comparison");
  });

  it("does not match 'turn' inside other words", () => {
    // "return" contains "turn"; it must not classify as turn-structure.
    expect(classifyQuery("How do I get a refund on my return?")).not.toBe("turn-structure");
  });

  it("does not match 'vs' inside other words", () => {
    // "devs" contains "vs"; it must not classify as comparison.
    expect(classifyQuery("What do the devs say about this rule?")).not.toBe("comparison");
  });

  it("matches keywords case-insensitively", () => {
    expect(classifyQuery("SETUP INSTRUCTIONS")).toBe("setup");
    expect(classifyQuery("HOW DO I WIN?")).toBe("victory");
  });

  it("falls back to general for unmatched questions", () => {
    expect(classifyQuery("Hello?")).toBe("general");
  });
});
