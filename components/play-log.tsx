"use client";

import { useEffect, useState } from "react";

interface Play {
  date: string;
  players?: number;
}

export default function PlayLog({ slug }: { slug: string }) {
  const [plays, setPlays] = useState<Play[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [logging, setLogging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/games/${slug}/plays`)
      .then((r) => (r.ok ? r.json() : { plays: [] }))
      .then((data) => {
        if (cancelled) return;
        setPlays(data.plays ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function logPlay() {
    setLogging(true);
    try {
      const res = await fetch(`/api/games/${slug}/plays`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) setPlays((await res.json()).plays);
    } finally {
      setLogging(false);
    }
  }

  const last = plays[0];
  const lastDate = last ? new Date(last.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;

  return (
    <div className="rounded-2xl border border-latte/60 bg-parchment/40 p-5 shadow-sm dark:border-cocoa/40 dark:bg-nightcard/60">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-xl text-espresso dark:text-parchment">Game night log</h2>
          <p className="mt-1 text-sm text-cocoa dark:text-latte">
            {plays.length > 0
              ? `Played ${plays.length} time${plays.length === 1 ? "" : "s"} · last ${lastDate}`
              : "No games logged yet — tap the button the night you play it."}
          </p>
        </div>
        <button
          onClick={logPlay}
          disabled={!loaded || logging}
          className="rounded-lg bg-terracotta px-4 py-2 text-sm text-cream transition-colors hover:bg-terracotta/90 disabled:opacity-50 dark:text-espresso"
        >
          {logging ? "Logging…" : "🎲 We played this"}
        </button>
      </div>
      {plays.length > 1 && (
        <ul className="mt-3 space-y-1 text-xs text-cocoa/80 dark:text-latte/70">
          {plays.slice(0, 5).map((p, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="text-cocoa/50 dark:text-latte/40">•</span>
              {new Date(p.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              {p.players ? ` · ${p.players} players` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
