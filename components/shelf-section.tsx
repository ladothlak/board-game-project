"use client";

import { useEffect, useMemo, useState } from "react";
import type { GameMeta } from "@/lib/games";
import GameGrid from "@/components/game-grid";
import FindGameModal from "@/components/find-game-modal";
import GameNightPicker from "@/components/game-night-picker";
import AddGame from "@/components/add-game";


/**
 * Wraps the shelf header (four action buttons on one line) with the find-game
 * modal and the filtered grid. Owns the filter state so the trigger button
 * and the modal stay in sync.
 */
export default function ShelfSection({ games: initialGames }: { games: GameMeta[] }) {
  const [games, setGames] = useState<GameMeta[]>(initialGames);
  const [findOpen, setFindOpen] = useState(false);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  // Poll for description updates from the digest pipeline.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/games/meta");
        if (!res.ok) return;
        const data: { games: GameMeta[] } = await res.json();
        if (cancelled) return;
        setGames((prev) => {
          // Merge per-slug so fields absent from the payload (e.g. rating)
          // are preserved. Also pick up newly added games.
          const incoming = new Map(data.games.map((n) => [n.slug, n]));
          const merged = prev.map((g) => {
            const n = incoming.get(g.slug);
            return n ? { ...g, ...n } : g;
          });
          // Append any new slugs not already in the list.
          for (const n of data.games) {
            if (!prev.some((g) => g.slug === n.slug)) {
              merged.push(n);
            }
          }
          return merged;
        });
      } catch {
        // Network error — silently skip this poll.
      }
    }
    const id = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return games.filter((g) => {
      if (activeTags.size > 0) {
        const gTags = new Set(g.tags ?? []);
        for (const t of activeTags) {
          if (!gTags.has(t)) return false;
        }
      }
      if (q) {
        const haystack = [g.title, g.description ?? "", ...(g.tags ?? [])]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [games, activeTags, query]);

  function toggleTag(tag: string) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  const hasFilters = activeTags.size > 0 || query.trim().length > 0;

  return (
    <>
      <section className="mt-10 flex flex-wrap items-center justify-between gap-4">
        <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
          On the shelf
        </h2>
        <div className="flex items-stretch gap-2 sm:gap-3">
          <button
            onClick={() => setFindOpen(true)}
            className="flex-1 rounded-lg bg-sage/70 px-4 py-2 text-center text-sm text-espresso transition-colors hover:bg-sage dark:text-parchment"
          >
            🔍 Find a Game
          </button>
          <GameNightPicker games={games} />
          <AddGame />
        </div>
      </section>

      {hasFilters && (
        <p className="mt-2 text-xs text-cocoa/70 dark:text-latte/60">
          Showing {filtered.length} of {games.length} games
        </p>
      )}

      <FindGameModal
        open={findOpen}
        onClose={() => setFindOpen(false)}
        games={games}
        activeTags={activeTags}
        query={query}
        shownCount={filtered.length}
        onToggleTag={toggleTag}
        onQuery={setQuery}
        onClear={() => {
          setActiveTags(new Set());
          setQuery("");
        }}
      />

      <section className="mt-6">
        {games.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-2xl bg-parchment/40 px-8 py-12 text-center dark:bg-nightcard/60">
            <span className="text-5xl" aria-hidden>📦</span>
            <h2 className="font-serif text-2xl font-bold text-espresso dark:text-parchment">
              The shelf is empty
            </h2>
            <p className="max-w-sm text-cocoa/70 dark:text-latte/70">
              No games on the menu yet. Add your first rulebook and the
              parlor will be ready to brew.
            </p>
          </div>
        ) : (
          <GameGrid games={filtered} />
        )}
      </section>
    </>
  );
}
