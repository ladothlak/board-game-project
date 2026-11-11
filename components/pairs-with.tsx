"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { GameMeta } from "@/lib/games";

interface PairItem {
  slug: string;
  reason: string;
}

/**
 * "Pairs well with" — LLM-generated complementary game suggestions.
 * Fetches from /api/games/[slug]/pairs (generates on first call, caches after).
 */
export default function PairsWith({ slug, games }: { slug: string; games: GameMeta[] }) {
  const [pairs, setPairs] = useState<PairItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/games/${slug}/pairs`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Server error"))))
      .then((data) => {
        if (!cancelled && data?.pairs) {
          setPairs(data.pairs);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Unavailable right now.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loading) {
    return (
      <section className="mt-6">
        <h2 className="font-serif text-lg text-espresso dark:text-parchment">
          Pairs well with…
        </h2>
        <div className="mt-3 flex items-center gap-2 text-sm text-cocoa/70 dark:text-latte/60">
          <span className="steam" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          Brewing a suggestion…
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="mt-6">
        <h2 className="font-serif text-lg text-espresso dark:text-parchment">
          Pairs well with…
        </h2>
        <p className="mt-2 text-sm text-cocoa/70 dark:text-latte/60">{error}</p>
      </section>
    );
  }

  if (!pairs || pairs.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="font-serif text-lg text-espresso dark:text-parchment">
        Pairs well with…
      </h2>
      <p className="mt-1 text-xs text-cocoa/70 dark:text-latte/60">
        Games that complement this one for a longer session.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {pairs.map((p) => {
          const game = games.find((g) => g.slug === p.slug);
          return (
            <Link
              key={p.slug}
              href={`/games/${p.slug}`}
              className="flex min-h-[7.5rem] items-center gap-3 rounded-xl border border-latte/60 bg-parchment/40 p-3 shadow-sm transition-colors hover:border-terracotta/50 dark:border-cocoa/40 dark:bg-nightcard/60 dark:hover:border-amberglow/50"
            >
              {game?.image && (
                <img
                  src={`/api/games/${p.slug}/file?name=${encodeURIComponent(game.image)}`}
                  alt={game.title}
                  className="h-24 w-24 shrink-0 rounded-lg object-cover"
                />
              )}
              <div>
                <span className="font-serif text-base text-espresso dark:text-parchment">
                  {game?.title ?? p.slug.replace(/-/g, " ")}
                </span>
                <p className="mt-1 text-sm text-cocoa/70 dark:text-latte/60">
                  {p.reason}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
