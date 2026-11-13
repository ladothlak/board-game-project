// Shared labelled benchmark dataset for the RAG tests (issue #66).
//
// Each entry carries a human-labelled query type and the page(s) that answer
// it, so classification accuracy and retrieval quality can be scored. This
// module is pure data with no side effects, so both `rag-benchmark.test.ts`
// (which scores it) and `rag-classification.test.ts` (which cross-checks its
// coverage) can import it without registering test suites.

import type { QueryType } from "../rag";

export interface Case {
  slug: string;
  question: string;
  expectedType: QueryType;
  expectedPages: number[];
}

export const DATASET: Case[] = [
  // Agricola
  { slug: "agricola", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "agricola", question: "What happens when I plow a field?", expectedType: "specific-rule", expectedPages: [6] },
  { slug: "agricola", question: "How do I play the solo version of Agricola?", expectedType: "edge-case", expectedPages: [9] },
  { slug: "agricola", question: "How many Minor Improvement cards does each player get at the start?", expectedType: "specific-rule", expectedPages: [3] },
  // Catan
  { slug: "catan", question: "How do I set up the board?", expectedType: "setup", expectedPages: [3] },
  { slug: "catan", question: "What is special about the desert hex?", expectedType: "specific-rule", expectedPages: [7] },
  { slug: "catan", question: "How does trading work in Catan?", expectedType: "specific-rule", expectedPages: [11, 14] },
  { slug: "catan", question: "What are the number tokens used for?", expectedType: "specific-rule", expectedPages: [10] },
  { slug: "catan", question: "How do I get the Longest Road card?", expectedType: "specific-rule", expectedPages: [9] },
  { slug: "catan", question: "What is the Distance Rule for building a settlement?", expectedType: "edge-case", expectedPages: [5] },
  { slug: "catan", question: "What is the order of the phases in my turn?", expectedType: "turn-structure", expectedPages: [8] },
  { slug: "catan", question: "What is my goal in Catan?", expectedType: "specific-rule", expectedPages: [16] },
  // Container
  { slug: "container", question: "What actions can I take during my turn?", expectedType: "turn-structure", expectedPages: [2] },
  { slug: "container", question: "How do I move my ship from the Open Sea to Auction?", expectedType: "specific-rule", expectedPages: [3] },
  { slug: "container", question: "What does the errata say about paying interest?", expectedType: "edge-case", expectedPages: [4] },
  // Nemesis: Lockdown
  { slug: "nemesis-lockdown", question: "How do I set up the board in Nemesis?", expectedType: "setup", expectedPages: [6] },
  { slug: "nemesis-lockdown", question: "When does the game end?", expectedType: "specific-rule", expectedPages: [12, 13] },
  { slug: "nemesis-lockdown", question: "What happens when an Intruder appears in a room with me?", expectedType: "edge-case", expectedPages: [20] },
  { slug: "nemesis-lockdown", question: "How do I fight an Intruder in combat?", expectedType: "specific-rule", expectedPages: [21, 22] },
  { slug: "nemesis-lockdown", question: "What is the difference between Light and Serious wounds?", expectedType: "comparison", expectedPages: [23] },
  { slug: "nemesis-lockdown", question: "How do Exploration tokens work?", expectedType: "specific-rule", expectedPages: [17] },
  { slug: "nemesis-lockdown", question: "How do I play Nemesis in solo mode?", expectedType: "edge-case", expectedPages: [30] },
  { slug: "nemesis-lockdown", question: "What is special about Crossroads rooms?", expectedType: "specific-rule", expectedPages: [31] },
  // Root
  { slug: "root", question: "How do I set up for three players?", expectedType: "setup", expectedPages: [4] },
  { slug: "root", question: "What happens when you battle another player?", expectedType: "specific-rule", expectedPages: [8] },
  { slug: "root", question: "What is turmoil and how do I resolve it?", expectedType: "edge-case", expectedPages: [13] },
  { slug: "root", question: "How does the Vagabond battle without warriors?", expectedType: "specific-rule", expectedPages: [20] },
  { slug: "root", question: "What are dominance cards and how do they work?", expectedType: "specific-rule", expectedPages: [21] },
  { slug: "root", question: "What happens during the Evening phase?", expectedType: "turn-structure", expectedPages: [11] },
  { slug: "root", question: "How do I use a card for crafting?", expectedType: "specific-rule", expectedPages: [7] },
  { slug: "root", question: "What are clearings and slots on the map?", expectedType: "specific-rule", expectedPages: [6] },
  { slug: "root", question: "How does the Marquise score victory points?", expectedType: "specific-rule", expectedPages: [10] },
  // Anachrony
  { slug: "anachrony", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "anachrony", question: "How do I win?", expectedType: "victory", expectedPages: [10, 11] },
  { slug: "anachrony", question: "What happens when I get a third Paradox token?", expectedType: "edge-case", expectedPages: [5] },
  { slug: "anachrony", question: "What happens during the Clean Up phase?", expectedType: "turn-structure", expectedPages: [6] },
  // Betrayal at House on the Hill
  { slug: "betrayal-at-house-on-the-hill", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "betrayal-at-house-on-the-hill", question: "How do I win the haunt?", expectedType: "victory", expectedPages: [9] },
  { slug: "betrayal-at-house-on-the-hill", question: "What happens during combat?", expectedType: "specific-rule", expectedPages: [8] },
  { slug: "betrayal-at-house-on-the-hill", question: "How do I draw Event, Item, and Omen cards?", expectedType: "turn-structure", expectedPages: [6] },
  // Brass: Birmingham
  { slug: "brass-birmingham", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "brass-birmingham", question: "How do I win?", expectedType: "victory", expectedPages: [6, 7] },
  { slug: "brass-birmingham", question: "How does the Build action work?", expectedType: "specific-rule", expectedPages: [5] },
  { slug: "brass-birmingham", question: "How does the Sell action work?", expectedType: "specific-rule", expectedPages: [6] },
  // Castles of Burgundy
  { slug: "castles-of-burgundy", question: "How do I set up the game?", expectedType: "setup", expectedPages: [5] },
  { slug: "castles-of-burgundy", question: "How do I win?", expectedType: "victory", expectedPages: [12] },
  { slug: "castles-of-burgundy", question: "What are the game phases?", expectedType: "turn-structure", expectedPages: [6] },
  { slug: "castles-of-burgundy", question: "How do I sell goods?", expectedType: "specific-rule", expectedPages: [10] },
  // Coup
  { slug: "coup", question: "How do I win?", expectedType: "victory", expectedPages: [1] },
  { slug: "coup", question: "What actions can I take?", expectedType: "specific-rule", expectedPages: [1] },
  // Kabuto Sumo
  { slug: "kabuto-sumo", question: "How do I set up the game?", expectedType: "setup", expectedPages: [2] },
  { slug: "kabuto-sumo", question: "How do I win?", expectedType: "victory", expectedPages: [3, 4] },
  { slug: "kabuto-sumo", question: "What happens on my turn?", expectedType: "turn-structure", expectedPages: [3] },
  // Nemesis: Retaliation
  { slug: "nemesis-retaliation", question: "How do I set up the game?", expectedType: "setup", expectedPages: [8, 10] },
  { slug: "nemesis-retaliation", question: "How does the game end?", expectedType: "victory", expectedPages: [9] },
  { slug: "nemesis-retaliation", question: "What happens during a player's turn?", expectedType: "turn-structure", expectedPages: [12] },
  { slug: "nemesis-retaliation", question: "How do intruders move?", expectedType: "specific-rule", expectedPages: [30] },
  // Puerto Rico
  { slug: "puerto-rico", question: "How do I set up the game?", expectedType: "setup", expectedPages: [6, 7] },
  { slug: "puerto-rico", question: "How do I win?", expectedType: "victory", expectedPages: [33] },
  { slug: "puerto-rico", question: "What happens during the Craftsman phase?", expectedType: "turn-structure", expectedPages: [12] },
  { slug: "puerto-rico", question: "How do I build a building?", expectedType: "specific-rule", expectedPages: [18] },
  // Tacta
  { slug: "tacta", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "tacta", question: "How do I win?", expectedType: "victory", expectedPages: [6] },
  { slug: "tacta", question: "How do I place my cards?", expectedType: "specific-rule", expectedPages: [4] },
  // Azul
  { slug: "azul", question: "How do I set up the game?", expectedType: "setup", expectedPages: [2] },
  { slug: "azul", question: "How do I win?", expectedType: "victory", expectedPages: [3, 5] },
  { slug: "azul", question: "What happens during the draft phase?", expectedType: "turn-structure", expectedPages: [3] },
  // Carcassonne
  { slug: "carcassonne", question: "How do I set up the game?", expectedType: "setup", expectedPages: [1] },
  { slug: "carcassonne", question: "How do I win?", expectedType: "victory", expectedPages: [4] },
  { slug: "carcassonne", question: "How do I score a completed city?", expectedType: "specific-rule", expectedPages: [3] },
  // Cascadia
  { slug: "cascadia", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3, 4] },
  { slug: "cascadia", question: "How do I win?", expectedType: "victory", expectedPages: [9] },
  { slug: "cascadia", question: "What happens during my turn?", expectedType: "turn-structure", expectedPages: [5] },
  // Catan (2nd edition)
  { slug: "catan-2", question: "How do I set up the board?", expectedType: "setup", expectedPages: [3] },
  { slug: "catan-2", question: "What is my goal in the game?", expectedType: "victory", expectedPages: [16] },
  { slug: "catan-2", question: "What is the order of the phases in my turn?", expectedType: "turn-structure", expectedPages: [8] },
  // Clank
  { slug: "clank", question: "How do I set up the game?", expectedType: "setup", expectedPages: [2] },
  { slug: "clank", question: "How does deck building work in Clank?", expectedType: "turn-structure", expectedPages: [4, 5] },
  { slug: "clank", question: "How does damage work?", expectedType: "specific-rule", expectedPages: [8] },
  // Dominion
  { slug: "dominion", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "dominion", question: "When does the game end?", expectedType: "victory", expectedPages: [6] },
  { slug: "dominion", question: "What do I do on my turn?", expectedType: "turn-structure", expectedPages: [5] },
  // Everdell
  { slug: "everdell", question: "How do I set up the game?", expectedType: "setup", expectedPages: [6, 7] },
  { slug: "everdell", question: "When does the game end?", expectedType: "victory", expectedPages: [14] },
  { slug: "everdell", question: "What actions can I take on my turn?", expectedType: "turn-structure", expectedPages: [8] },
  // Flash Point
  { slug: "flash-point", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "flash-point", question: "What are the three phases of my turn?", expectedType: "turn-structure", expectedPages: [4] },
  { slug: "flash-point", question: "How do I extinguish fire?", expectedType: "specific-rule", expectedPages: [5] },
  // Gloomhaven
  { slug: "how-to-play-gloomhaven-official-rules-ultraboardgames", question: "How do I set up the play area?", expectedType: "setup", expectedPages: [5] },
  { slug: "how-to-play-gloomhaven-official-rules-ultraboardgames", question: "What is the victory condition?", expectedType: "victory", expectedPages: [16] },
  { slug: "how-to-play-gloomhaven-official-rules-ultraboardgames", question: "What happens during my turn?", expectedType: "turn-structure", expectedPages: [17, 18] },
  // Hanamikoji
  { slug: "how-to-play-hanamikoji-official-rules-ultraboardgames", question: "What actions can I take?", expectedType: "turn-structure", expectedPages: [2] },
  { slug: "how-to-play-hanamikoji-official-rules-ultraboardgames", question: "How is scoring done?", expectedType: "victory", expectedPages: [1] },
  // Kingdomino
  { slug: "how-to-play-kingdomino-official-rules-ultraboardgames", question: "How do I set up the game?", expectedType: "setup", expectedPages: [2] },
  { slug: "how-to-play-kingdomino-official-rules-ultraboardgames", question: "How do I place a domino?", expectedType: "specific-rule", expectedPages: [3] },
  // Munchkin
  { slug: "munchkin", question: "What happens when I look for trouble?", expectedType: "specific-rule", expectedPages: [2] },
  // Oasis
  { slug: "oasis-rules-and-questions", question: "What is the goal of the game?", expectedType: "victory", expectedPages: [2] },
  { slug: "oasis-rules-and-questions", question: "What happens on my turn?", expectedType: "turn-structure", expectedPages: [3] },
  { slug: "oasis-rules-and-questions", question: "How do animals attract their own kind?", expectedType: "specific-rule", expectedPages: [4] },
  // Pandemic
  { slug: "pandemic", question: "How do I set up the game?", expectedType: "setup", expectedPages: [1] },
  { slug: "pandemic", question: "What are my actions on my turn?", expectedType: "turn-structure", expectedPages: [5] },
  { slug: "pandemic", question: "How do I win?", expectedType: "victory", expectedPages: [1] },
  // Patchwork
  { slug: "patchwork", question: "How do I set up the game?", expectedType: "setup", expectedPages: [1] },
  { slug: "patchwork", question: "What happens during my turn?", expectedType: "turn-structure", expectedPages: [1] },
  // Sagrada
  { slug: "sagrada", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3, 4] },
  { slug: "sagrada", question: "How do I win?", expectedType: "victory", expectedPages: [8] },
  { slug: "sagrada", question: "What actions can I take?", expectedType: "turn-structure", expectedPages: [7] },
  // Scythe
  { slug: "scythe", question: "How do I set up the game?", expectedType: "setup", expectedPages: [6, 7] },
  { slug: "scythe", question: "What is the goal of the game?", expectedType: "victory", expectedPages: [1, 29] },
  { slug: "scythe", question: "How does the action selection work?", expectedType: "turn-structure", expectedPages: [10] },
  // Splendor
  { slug: "splendor", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "splendor", question: "How do I win?", expectedType: "victory", expectedPages: [3] },
  // Viticulture
  { slug: "viticulture", question: "How do I set up the game?", expectedType: "setup", expectedPages: [3] },
  { slug: "viticulture", question: "What actions can I take in summer?", expectedType: "turn-structure", expectedPages: [8] },
  { slug: "viticulture", question: "How do I win?", expectedType: "victory", expectedPages: [1] },
  // Wingspan
  { slug: "wingspan", question: "How do I set up the game?", expectedType: "setup", expectedPages: [2] },
  { slug: "wingspan", question: "What happens at the end of a round?", expectedType: "turn-structure", expectedPages: [4, 5] },
  { slug: "wingspan", question: "How do I win?", expectedType: "victory", expectedPages: [11] },
];
