"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { GameMeta } from "@/lib/games";

/**
 * Lists the games that have been taken off the shelf (data kept on disk) and
 * lets you restore any of them. Only renders when there is at least one.
 */
export default function HiddenGames({ games }: { games: GameMeta[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const router = useRouter();

  if (games.length === 0) return null;

  async function restore(slug: string) {
    setBusy(slug);
    try {
      const res = await fetch(`/api/games/${slug}/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "restore" }),
      });
      if (!res.ok) return;
      router.refresh(); // the game reappears on the shelf
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="font-serif text-xl text-cocoa dark:text-latte">
        Off the shelf
      </h2>
      <p className="mt-1 text-sm text-cocoa/80 dark:text-latte/70">
        These games are kept on disk but hidden from the shelf. Restore any of
        them to bring them back.
      </p>
      <ul className="mt-4 flex flex-wrap gap-3">
        {games.map((g) => (
          <li
            key={g.slug}
            className="flex items-center gap-2 rounded-xl border border-latte/60 bg-parchment/40 px-4 py-2 text-sm dark:border-cocoa/50 dark:bg-nightcard"
          >
            <span className="text-cocoa dark:text-latte">{g.title}</span>
            <button
              onClick={() => restore(g.slug)}
              disabled={busy !== null}
              className="rounded-md bg-sage/70 px-2.5 py-1 text-xs font-medium text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
            >
              {busy === g.slug ? "Restoring…" : "Restore"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
