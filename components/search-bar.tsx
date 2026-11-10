"use client";

import { useEffect, useMemo, useState } from "react";
import Fuse from "fuse.js";
import Link from "next/link";

interface Entry {
  id: string;
  slug: string;
  title: string;
  page: number;
  text: string;
}

function snippet(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 40);
  const to = Math.min(text.length, end + 80);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

export default function SearchBar() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ entry: Entry; snippet: string }>>([]);

  useEffect(() => {
    fetch("/search-index.json")
      .then((r) => r.json())
      .then((data) => setEntries(data.entries ?? []))
      .catch(() => setEntries([]));
  }, []);

  const fuse = useMemo(
    () =>
      entries
        ? new Fuse(entries, {
            keys: ["title", "text"],
            threshold: 0.4,
            ignoreLocation: true,
            includeMatches: true,
            minMatchCharLength: 3,
          })
        : null,
    [entries]
  );

  useEffect(() => {
    if (!fuse || q.trim().length < 3) {
      setResults([]);
      return;
    }
    let cancelled = false;
    (async () => {
      // Only surface games that are currently on the shelf. Hidden and
      // deleted games are excluded so search stays in sync with the shelf.
      const visible = new Set<string>();
      let known = true;
      try {
        const res = await fetch("/api/games/visible");
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        for (const s of data.slugs ?? []) visible.add(s);
      } catch {
        known = false; // on failure, show all results rather than none
      }
      if (cancelled) return;
      try {
        const out: Array<{ entry: Entry; snippet: string }> = [];
        for (const r of fuse.search(q).slice(0, 8)) {
          if (known && !visible.has(r.item.slug)) continue;
          const match = r.matches?.find((m) => m.key === "text");
          const first = match?.indices?.[0];
          out.push({
            entry: r.item,
            snippet: first ? snippet(r.item.text, first[0], first[1]) : r.item.text.slice(0, 120),
          });
        }
        setResults(out);
      } catch {
        setResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [q, fuse]);

  return (
    <div className="relative mx-auto max-w-2xl">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search every rulebook — “what happens when the outbreak reaches critical mass?”"
        aria-label="Search rulebooks"
        className="w-full rounded-xl border border-latte/70 bg-parchment/60 px-4 py-3 text-espresso placeholder:text-cocoa/60 focus:border-terracotta focus:outline-none focus:ring-2 focus:ring-terracotta/30 dark:border-cocoa/50 dark:bg-nightcard dark:text-parchment dark:placeholder:text-latte/50"
      />
      {results.length > 0 && (
        <ul className="absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-latte/70 bg-cream shadow-lg dark:border-cocoa/50 dark:bg-nightcard">
          {results.map(({ entry, snippet: s }) => (
            <li key={entry.id} className="border-b border-latte/40 last:border-0 dark:border-cocoa/30">
              <Link
                href={`/games/${entry.slug}?page=${entry.page}`}
                onClick={() => setQ("")}
                className="block px-4 py-3 hover:bg-parchment/60 dark:hover:bg-cocoa/20"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-serif text-espresso dark:text-parchment">{entry.title}</span>
                  <span className="rounded-full bg-latte/40 px-2 py-0.5 text-xs text-cocoa dark:bg-cocoa/30 dark:text-latte">
                    p. {entry.page}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-cocoa dark:text-latte">{s}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
