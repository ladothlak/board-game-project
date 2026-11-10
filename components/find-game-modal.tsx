"use client";

import { useMemo } from "react";
import type { GameMeta } from "@/lib/games";
import { useDialog } from "@/hooks/use-dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  games: GameMeta[];
  activeTags: Set<string>;
  query: string;
  shownCount: number;
  onToggleTag: (tag: string) => void;
  onQuery: (v: string) => void;
  onClear: () => void;
}

/**
 * A modal for narrowing the shelf: a search box plus the top five genres as
 * toggle chips. Presentational — the parent owns the filter state so it can
 * feed the filtered list to the grid behind the modal.
 */
export default function FindGameModal({
  open,
  onClose,
  games,
  activeTags,
  query,
  shownCount,
  onToggleTag,
  onQuery,
  onClear,
}: Props) {
  // The five most common tags across the shelf.
  const topTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of games) for (const t of g.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag);
  }, [games]);

  const hasFilters = activeTags.size > 0 || query.trim().length > 0;
  const { panelRef } = useDialog(open, onClose);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Find a Game"
        className="w-full max-w-md rounded-2xl border border-latte/60 bg-parchment/90 p-6 shadow-xl dark:border-cocoa/40 dark:bg-nightcard/95"
      >
        <h3 className="font-serif text-xl text-espresso dark:text-parchment">
          Find a Game
        </h3>
        <p className="mt-1 text-sm text-cocoa dark:text-latte">
          Pick a genre and search the shelf.
        </p>

        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search by name, tag, or description…"
          aria-label="Search games"
          className="mt-4 w-full rounded-lg border border-latte/70 bg-parchment/60 px-3 py-2 text-sm text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
        />

        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-cocoa/70 dark:text-latte/60">
            Top genres
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {topTags.map((tag) => (
              <button
                key={tag}
                onClick={() => onToggleTag(tag)}
                className={`rounded-full px-3 py-1 text-sm transition-colors ${
                  activeTags.has(tag)
                    ? "bg-sage/70 text-espresso dark:text-parchment"
                    : "bg-latte/40 text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <span className="text-xs text-cocoa/70 dark:text-latte/60">
            Showing {shownCount} of {games.length} games
          </span>
          <div className="flex items-center gap-2">
            {hasFilters && (
              <button
                onClick={onClear}
                className="rounded-lg bg-terracotta/30 px-3 py-1.5 text-sm text-terracotta transition-colors hover:bg-terracotta/50 dark:text-amberglow"
              >
                Clear
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-lg bg-sage/70 px-4 py-2 text-sm text-espresso transition-colors hover:bg-sage dark:text-parchment"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
