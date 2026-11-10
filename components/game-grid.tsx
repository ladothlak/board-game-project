"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { GameMeta } from "@/lib/games";
import RemoveGame from "@/components/remove-game";

export default function GameGrid({ games }: { games: GameMeta[] }) {
  const [sort, setSort] = useState<"title" | "playtime" | "rating">("title");

  const visible = useMemo(() => {
    return [...games].sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "playtime") return (a.playtimeMinutes ?? 999) - (b.playtimeMinutes ?? 999);
      // Rating: unrated games sink to the bottom.
      return (b.rating ?? 0) - (a.rating ?? 0);
    });
  }, [games, sort]);

  if (games.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-latte bg-parchment/40 p-8 text-center text-cocoa dark:border-cocoa/50 dark:bg-nightcard dark:text-latte">
        The shelf is empty so far. Add a game under content/games/ to get started.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-cocoa dark:text-latte">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as "title" | "playtime")}
            className="rounded-lg border border-latte/70 bg-parchment/60 px-2 py-1 text-espresso focus:outline-none dark:border-cocoa/50 dark:bg-nightcard dark:text-parchment"
          >
            <option value="title">title</option>
            <option value="playtime">playtime</option>
            <option value="rating">our rating</option>
          </select>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((game) => (
          <div key={game.slug} className="relative">
            <Link
              href={`/games/${game.slug}`}
              className="fade-up group block overflow-hidden rounded-2xl border border-latte/60 bg-parchment/50 shadow-sm transition-shadow hover:shadow-md dark:border-cocoa/40 dark:bg-nightcard"
            >
            <div className="relative h-40 overflow-hidden bg-latte/30 dark:bg-cocoa/20">
              {game.image ? (
                <Image
                  src={`/api/games/${game.slug}/file?name=${encodeURIComponent(game.image)}`}
                  alt={`${game.title} box`}
                  fill
                  sizes="100%"
                  className="object-cover transition-transform duration-300 group-hover:scale-105"
                />
              ) : (
                <div className="flex h-full items-center justify-center font-serif text-3xl text-cocoa/60 dark:text-latte/50">
                  {game.title.charAt(0)}
                </div>
              )}
            </div>
            <div className="p-4">
              <h3 className="font-serif text-lg text-espresso group-hover:text-terracotta dark:text-parchment dark:group-hover:text-amberglow">
                {game.title}
              </h3>
              <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-cocoa dark:text-latte">
                {game.description || "The description is still brewing…"}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                {game.complexity != null && (
                  <span
                    className="rounded-full bg-sage/30 px-2 py-0.5 text-espresso dark:text-parchment"
                    title={`Complexity ${game.complexity}/5`}
                  >
                    {"●".repeat(game.complexity)}{"○".repeat(5 - game.complexity)}
                  </span>
                )}
                {game.players && (
                  <span className="rounded-full bg-latte/40 px-2 py-0.5 text-cocoa dark:bg-cocoa/30 dark:text-latte">
                    {game.players}
                  </span>
                )}
                {game.playtimeMinutes && (
                  <span className="rounded-full bg-latte/40 px-2 py-0.5 text-cocoa dark:bg-cocoa/30 dark:text-latte">
                    ~{game.playtimeMinutes} min
                  </span>
                )}
                {game.rating != null && (
                  <span
                    className="rounded-full bg-amberglow/20 px-2 py-0.5 text-cocoa dark:text-latte"
                    title={`Rated ${game.rating}/5`}
                  >
                    ★ {game.rating}
                  </span>
                )}
                {(game.tags ?? []).map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-sage/25 px-2 py-0.5 text-cocoa dark:text-latte"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </Link>
            <div className="absolute right-2 top-2 z-10">
              <RemoveGame slug={game.slug} title={game.title} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
