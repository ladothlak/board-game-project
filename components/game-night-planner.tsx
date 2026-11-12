"use client";

import { useState } from "react";
import Link from "next/link";
import type { GameMeta } from "@/lib/games";

/**
 * A simple planner: enter a date and headcount, get a game suggestion
 * with an estimated total evening time (setup + play + cleanup).
 */
export default function GameNightPlanner({ games }: { games: GameMeta[] }) {
  const [date, setDate] = useState("");
  const [players, setPlayers] = useState("");
  const [result, setResult] = useState<GameMeta | null>(null);

  function plan() {
    const count = Number(players);
    if (!Number.isFinite(count) || count < 1 || games.length === 0) return;

    // Simple scoring: fits player count + not too long.
    let best: GameMeta | null = null;
    let bestScore = -Infinity;
    for (const g of games) {
      let score = 0;
      const range = g.players?.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (range) {
        if (count >= Number(range[1]) && count <= Number(range[2])) score += 3;
        else score -= 4;
      }
      if (g.playtimeMinutes != null) {
        if (g.playtimeMinutes <= 120) score += 2;
        else if (g.playtimeMinutes <= 180) score += 1;
        else score -= 1;
      }
      score += Math.random(); // tiebreak
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }
    setResult(best);
  }

  function estimateTotal(g: GameMeta): string {
    const play = g.playtimeMinutes ?? 60;
    const setup = Math.max(5, Math.round(play * 0.1)); // ~10% for setup
    const cleanup = Math.max(3, Math.round(play * 0.05)); // ~5% for cleanup
    const total = play + setup + cleanup;
    return `~${total} min total (setup ${setup}m + play ${play}m + cleanup ${cleanup}m)`;
  }

  return (
    <div className="rounded-2xl border border-latte/60 bg-parchment/40 p-5 shadow-sm dark:border-cocoa/40 dark:bg-nightcard/60">
      <h2 className="font-serif text-xl text-espresso dark:text-parchment">
        Plan a game night
      </h2>
      <p className="mt-1 text-sm text-cocoa dark:text-latte">
        When are you playing and how many are coming?
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Game night date"
          className="rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-sm text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
        />
        <label className="flex items-center gap-1.5 text-xs text-cocoa dark:text-latte">
          Players
          <input
            value={players}
            onChange={(e) => setPlayers(e.target.value)}
            inputMode="numeric"
            placeholder="4"
            className="w-14 rounded-lg border border-latte/70 bg-parchment/50 px-2 py-2 text-sm text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
          />
        </label>
        <button
          onClick={plan}
          disabled={!players.trim()}
          className="rounded-lg bg-sage/70 px-4 py-2 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
        >
          Plan it
        </button>
      </div>

      {result && (
        <div className="fade-up mt-4 rounded-xl border border-latte/60 bg-parchment/60 p-4 shadow-sm dark:border-cocoa/40 dark:bg-night">
          <p className="text-sm text-cocoa dark:text-latte">
            {date && (
              <span>
                On{" "}
                <strong>
                  {new Date(date + "T12:00:00").toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })}
                </strong>
                , the parlor suggests{" "}
              </span>
            )}
            <Link
              href={`/games/${result.slug}`}
              className="font-serif text-base text-terracotta hover:underline dark:text-amberglow"
            >
              {result.title}
            </Link>
            .
          </p>
          <p className="mt-1 text-xs text-cocoa/70 dark:text-latte/60">
            {estimateTotal(result)}
          </p>
        </div>
      )}
    </div>
  );
}
