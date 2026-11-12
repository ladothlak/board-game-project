"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import SavedSearches from "@/components/saved-searches";

interface Recommendation {
  slug: string;
  title: string;
  reason: string;
  tags: string[];
  players?: string;
  playtimeMinutes?: number;
}

export default function GameFinder() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slowBrew, setSlowBrew] = useState(false);

  // Show "Still brewing…" if the LLM takes more than 15s.
  useEffect(() => {
    if (!loading) {
      setSlowBrew(false);
      return;
    }
    const id = setTimeout(() => setSlowBrew(true), 15_000);
    return () => clearTimeout(id);
  }, [loading]);

  async function ask() {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch("/api/find-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setResults(data.recommendations ?? []);
        // Auto-save the query for one-tap reuse.
        try {
          const key = "parlor-saved-searches";
          const raw = localStorage.getItem(key);
          const saved: Array<{ query: string; savedAt: string }> = raw ? JSON.parse(raw) : [];
          const filtered = saved.filter((s) => s.query.toLowerCase() !== q.trim().toLowerCase());
          const next = [{ query: q.trim(), savedAt: new Date().toISOString() }, ...filtered].slice(0, 6);
          localStorage.setItem(key, JSON.stringify(next));
        } catch { /* ignore */ }
      } else {
        setError(data.error ?? "Something went wrong.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='Describe your ideal game — "horror sci-fi cooperative for four players"'
          aria-label="Describe your ideal game"
          className="min-w-0 flex-1 rounded-xl border border-latte/70 bg-parchment/50 px-4 py-3 text-espresso placeholder:text-cocoa/60 focus:border-terracotta focus:outline-none focus:ring-2 focus:ring-terracotta/30 dark:border-cocoa/50 dark:bg-night dark:text-parchment dark:placeholder:text-latte/50"
        />
        <button
          type="submit"
          disabled={loading || !q.trim()}
          className="rounded-lg bg-sage/70 px-4 py-3 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
        >
          Ask
        </button>
      </form>

      <SavedSearches onPick={(query) => { setQ(query); ask(); }} />

      {loading && (
        <div className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-latte/60 bg-parchment/40 p-6 text-sm text-cocoa dark:border-cocoa/40 dark:bg-nightcard/60 dark:text-latte">
          <span className="steam" aria-hidden>
            <span></span><span></span><span></span>
          </span>
          {slowBrew ? "Still brewing — the model is thinking…" : "Brewing a recommendation…"}
        </div>
      )}

      {error && (
        <p className="mt-3 text-center text-sm text-terracotta dark:text-amberglow">
          {error}
        </p>
      )}

      {results && results.length === 0 && (
        <p className="mt-3 text-center text-sm text-cocoa/70 dark:text-latte/60">
          Nothing on the shelf quite matches that — try broadening your request.
        </p>
      )}

      {results && results.length > 0 && (
        <ul className="mt-4 space-y-3">
          {results.map((r) => (
            <li key={r.slug}>
              <Link
                href={`/games/${r.slug}`}
                className="block rounded-xl border border-latte/60 bg-parchment/40 p-4 shadow-sm transition-colors hover:border-terracotta/50 dark:border-cocoa/40 dark:bg-nightcard/60 dark:hover:border-amberglow/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-serif text-lg text-espresso dark:text-parchment">
                    {r.title}
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {r.tags.slice(0, 3).map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-latte/40 px-2 py-0.5 text-xs text-cocoa dark:bg-cocoa/30 dark:text-latte"
                      >
                        {t}
                      </span>
                    ))}
                  </span>
                </div>
                <p className="mt-1 text-sm text-cocoa dark:text-latte">{r.reason}</p>
                <div className="mt-2 flex gap-3 text-xs text-cocoa/70 dark:text-latte/60">
                  {r.players && <span>👤 {r.players}</span>}
                  {r.playtimeMinutes != null && <span>⏱ ~{r.playtimeMinutes} min</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
