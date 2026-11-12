"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { GameMeta } from "@/lib/games";
import GameGrid from "@/components/game-grid";

// The modals (and AddGame's bulk-add machinery) are only needed after their
// button is first clicked, so they're lazy-loaded out of the home page's
// initial JS. Each mounts with `open` already true on first click.
const FindGameModal = dynamic(() => import("@/components/find-game-modal"), { ssr: false });
const GameNightPicker = dynamic(() => import("@/components/game-night-picker"), { ssr: false });
const AddGame = dynamic(() => import("@/components/add-game"), { ssr: false });

/** Backdrop shown while a lazy-loaded modal's chunk is loading. */
function ModalLoadingBackdrop() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" aria-busy="true">
      <span className="steam" aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}


/**
 * Wraps the shelf header (three action buttons on one line) with the find-game
 * modal and the filtered grid. Owns the filter state so the trigger button
 * and the modal stay in sync.
 */
export default function ShelfSection({ games: initialGames }: { games: GameMeta[] }) {
  const [games, setGames] = useState<GameMeta[]>(initialGames);
  const [findOpen, setFindOpen] = useState(false);
  // Open state for the lazy-loaded modals. The trigger buttons live here in
  // the parent (never unmounted), so no button flickers while a chunk loads;
  // the modal itself mounts — and triggers its dynamic import — on open.
  const [addOpen, setAddOpen] = useState(false);
  const [nightOpen, setNightOpen] = useState(false);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  // Ctrl/⌘+K on the shelf opens the find modal.
  useEffect(() => {
    const handler = () => setFindOpen(true);
    window.addEventListener("parlor:open-find", handler);
    return () => window.removeEventListener("parlor:open-find", handler);
  }, []);

  // Poll for description updates from the digest pipeline. Paused while the
  // tab is hidden (and one immediate poll fires on return) so background tabs
  // stop hammering the server.
  useEffect(() => {
    let cancelled = false;
    let id: number | undefined;
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
    function start() {
      void poll();
      if (id === undefined) id = window.setInterval(poll, 10_000);
    }
    function stop() {
      if (id !== undefined) {
        clearInterval(id);
        id = undefined;
      }
    }
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) start();
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
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
      <section data-parlor-shelf className="mt-10 flex flex-wrap items-center justify-between gap-4">
        <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
          On the shelf
        </h2>
        <div className="flex w-full flex-wrap items-stretch gap-2 sm:w-auto sm:gap-3">
          {games.length > 0 && (
            <>
              <button
                onClick={() => setFindOpen(true)}
                className="flex-1 rounded-lg bg-sage/70 px-4 py-2 text-center text-sm text-espresso transition-colors hover:bg-sage dark:text-parchment"
              >
                🔍 Find a game
              </button>
              <button
                onClick={() => setNightOpen(true)}
                className="flex-1 rounded-lg bg-sage/70 px-4 py-2 text-center text-sm text-espresso transition-colors hover:bg-sage dark:text-parchment"
              >
                🎲 Pick a game
              </button>
            </>
          )}
          <button
            onClick={() => setAddOpen(true)}
            className="flex-1 rounded-lg bg-sage/70 px-4 py-2 text-center text-sm text-espresso transition-colors hover:bg-sage dark:text-parchment"
          >
            + Add a game
          </button>
        </div>
      </section>

      {hasFilters && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-cocoa/70 dark:text-latte/60">
          <span>
            Showing {filtered.length} of {games.length} games
          </span>
          <button
            onClick={() => {
              setActiveTags(new Set());
              setQuery("");
            }}
            className="rounded text-xs text-terracotta underline underline-offset-2 hover:text-espresso dark:text-amberglow dark:hover:text-parchment"
          >
            Clear filters
          </button>
        </p>
      )}

      {findOpen && (
        <Suspense fallback={<ModalLoadingBackdrop />}>
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
        </Suspense>
      )}

      {addOpen && (
        <Suspense fallback={<ModalLoadingBackdrop />}>
          <AddGame open={addOpen} onClose={() => setAddOpen(false)} />
        </Suspense>
      )}

      {nightOpen && (
        <Suspense fallback={<ModalLoadingBackdrop />}>
          <GameNightPicker games={games} open={nightOpen} onClose={() => setNightOpen(false)} />
        </Suspense>
      )}

      <section className="mt-6">
        {games.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-latte bg-parchment/40 px-8 py-12 text-center dark:border-cocoa/50 dark:bg-nightcard/60">
            <span className="text-5xl" aria-hidden>📦</span>
            <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
              The shelf is empty
            </h2>
            <p className="max-w-sm text-cocoa/70 dark:text-latte/70">
              No games on the menu yet. Add your first rulebook and the
              parlor will be ready to brew.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-latte bg-parchment/40 px-8 py-12 text-center dark:border-cocoa/50 dark:bg-nightcard/60">
            <span className="text-5xl" aria-hidden>🔍</span>
            <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
              Nothing matches those filters
            </h2>
            <p className="max-w-sm text-cocoa/70 dark:text-latte/70">
              Try a different genre or clear the search to see the whole shelf.
            </p>
            <button
              onClick={() => {
                setActiveTags(new Set());
                setQuery("");
              }}
              className="rounded-lg bg-latte/40 px-4 py-2 text-sm text-cocoa transition-colors hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <GameGrid games={filtered} />
        )}
      </section>
    </>
  );
}
