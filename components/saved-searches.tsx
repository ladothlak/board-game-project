"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "parlor-saved-searches";
const MAX_SAVED = 6;

interface SavedSearch {
  query: string;
  savedAt: string;
}

/**
 * Shows recently saved searches as one-tap chips. Saves the last query
 * automatically after each successful find.
 */
export default function SavedSearches({ onPick }: { onPick: (q: string) => void }) {
  const [saved, setSaved] = useState<SavedSearch[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  function save(query: string) {
    const q = query.trim();
    if (!q) return;
    setSaved((prev) => {
      // Remove if already saved, then prepend.
      const filtered = prev.filter((s) => s.query.toLowerCase() !== q.toLowerCase());
      const next = [{ query: q, savedAt: new Date().toISOString() }, ...filtered].slice(0, MAX_SAVED);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  }

  function remove(query: string) {
    setSaved((prev) => {
      const next = prev.filter((s) => s.query !== query);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  }

  if (saved.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-cocoa/70 dark:text-latte/60">Saved:</span>
      {saved.map((s) => (
        <span key={s.query} className="flex items-center gap-1">
          <button
            onClick={() => onPick(s.query)}
            className="rounded-full bg-sage/30 px-2.5 py-1 text-xs text-espresso hover:bg-sage/60 dark:text-parchment"
          >
            {s.query}
          </button>
          <button
            onClick={() => remove(s.query)}
            className="text-xs text-cocoa/50 hover:text-terracotta dark:text-latte/40"
            aria-label={`Remove "${s.query}"`}
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}
