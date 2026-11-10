"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { GameMeta } from "@/lib/games";

/**
 * Shows 2–3 other games that share tags with the current game.
 * Pure client-side — no LLM needed.
 */
export default function SimilarGames({
  current,
  games,
}: {
  current: GameMeta;
  games: GameMeta[];
}) {
  const similar = useMemo(() => {
    const currentTags = new Set(current.tags ?? []);
    if (currentTags.size === 0) return [];

    return games
      .filter((g) => g.slug !== current.slug)
      .map((g) => {
        const shared = (g.tags ?? []).filter((t) => currentTags.has(t));
        return { game: g, shared };
      })
      .filter((x) => x.shared.length > 0)
      .sort((a, b) => b.shared.length - a.shared.length)
      .slice(0, 3);
  }, [current, games]);

  if (similar.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="font-serif text-lg text-espresso dark:text-parchment">
        If you liked this, try…
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {similar.map(({ game, shared }) => (
          <Link
            key={game.slug}
            href={`/games/${game.slug}`}
            className="flex min-h-[7rem] items-center gap-3 rounded-xl border border-latte/60 bg-parchment/40 p-3 shadow-sm transition-colors hover:border-terracotta/50 dark:border-cocoa/40 dark:bg-nightcard/60 dark:hover:border-amberglow/50"
          >
            {game.image && (
              <img
                src={`/api/games/${game.slug}/file?name=${encodeURIComponent(game.image)}`}
                alt={game.title}
                className="h-14 w-14 rounded-lg object-cover"
              />
            )}
            <div>
              <span className="font-serif text-base text-espresso dark:text-parchment">
                {game.title}
              </span>
              <p className="mt-0.5 text-xs text-cocoa/70 dark:text-latte/60">
                Shared: {shared.join(", ")}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
