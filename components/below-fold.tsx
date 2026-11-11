"use client";

import dynamic from "next/dynamic";
import type { GameMeta } from "@/lib/games";

// Lazy-loaded: these sections are below the fold and don't need to block
// initial paint. The JS bundles are fetched on demand.
const KeyConcepts = dynamic(() => import("@/components/key-concepts"), { ssr: false });
const SetupChecklist = dynamic(() => import("@/components/setup-checklist"), { ssr: false });
const NotesSection = dynamic(() => import("@/components/notes-section"), { ssr: false });
const PlayLog = dynamic(() => import("@/components/play-log"), { ssr: false });
const SimilarGames = dynamic(() => import("@/components/similar-games"), { ssr: false });
const PairsWith = dynamic(() => import("@/components/pairs-with"), { ssr: false });

/**
 * Wraps all below-fold game-page sections in a single client component so
 * their JavaScript bundles are loaded lazily (after the initial paint).
 */
export default function BelowFold({
  slug,
  title,
  game,
  games,
}: {
  slug: string;
  title: string;
  game: GameMeta;
  games: GameMeta[];
}) {
  // The LLM-generated sections (concepts, checklist, pairs, similar) all
  // depend on a rulebook. Without one, show a single themed placeholder
  // instead — personal notes and the play log still work fine.
  const hasRulebook = Boolean(game.pdf);

  return (
    <>
      {hasRulebook ? (
        <>
          {/* Key gameplay concepts — LLM-generated index of major rulebook elements. */}
          <section className="mt-6">
            <KeyConcepts slug={slug} />
          </section>

          {/* Setup checklist — tick-off list generated from the rulebook. */}
          <section className="mt-6">
            <SetupChecklist slug={slug} />
          </section>
        </>
      ) : (
        <section className="mt-6">
          <p className="rounded-lg border border-dashed border-latte/40 p-4 text-sm italic text-cocoa/70 dark:border-cocoa/40 dark:text-latte/60">
            Waiting for the rulebook. The &apos;Pairs well with&apos;,
            &apos;If you liked this, try…&apos;, Key Concepts, and Setup
            Checklist sections will populate once the rulebook is added.
          </p>
        </section>
      )}

      {/* Personal notes */}
      <section className="mt-10">
        <NotesSection slug={slug} title={title} />
      </section>

      {/* Game night log */}
      <section className="mt-6">
        <PlayLog slug={slug} />
      </section>

      {hasRulebook && (
        <>
          {/* Pairs well with — LLM-generated complementary game suggestions. */}
          <PairsWith slug={slug} games={games} />

          {/* Similar games — tag-based recommendations. */}
          <SimilarGames current={game} games={games} />
        </>
      )}
    </>
  );
}
