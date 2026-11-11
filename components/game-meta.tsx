"use client";

import { useState, useEffect } from "react";
import type { Suggestion } from "@/lib/games";

type Field = "players" | "playtimeMinutes" | "ageRating";

interface Props {
  slug: string;
  players?: string;
  playtimeMinutes?: number;
  ageRating?: string;
  tags?: string[];
  suggestions?: Suggestion[];
}

/**
 * Renders the game's metadata pills. For any field that has a suggestion
 * (the user's value conflicts with what the rulebook says), shows the
 * suggestion right next to the pill with Accept / Dismiss controls.
 */
export default function GameMeta({
  slug,
  players,
  playtimeMinutes,
  ageRating,
  tags,
  suggestions: initialSuggestions,
}: Props) {
  const [playersV, setPlayersV] = useState(players);
  const [playtimeV, setPlaytimeV] = useState(playtimeMinutes);
  const [ageV, setAgeV] = useState(ageRating);
  const [tagsV, setTagsV] = useState<string[]>(tags ?? []);
  const [suggestions, setSuggestions] = useState<Suggestion[]>(initialSuggestions ?? []);
  const [busy, setBusy] = useState<Field | null>(null);

  // Re-fetch metadata when the rulebook is updated via the modal.
  // Fetches immediately, then repeats every 30s while the description is
  // still empty (i.e., digest in flight). Stops once fresh data lands.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.slug !== slug) return;
      const doFetch = () =>
        fetch(`/api/games/${slug}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!data) return;
            // While digesting, the server returns an empty description.
            // Keep polling until it's populated.
            if (data.description === "") {
              timer = setTimeout(doFetch, 30_000);
              return;
            }
            if (data.players != null) setPlayersV(data.players);
            if (data.playtimeMinutes != null) setPlaytimeV(data.playtimeMinutes);
            if (data.ageRating != null) setAgeV(data.ageRating);
            if (Array.isArray(data.tags)) setTagsV(data.tags);
          })
          .catch(() => {});
      doFetch();
    };
    window.addEventListener("rulebook-updated", handler);
    return () => {
      window.removeEventListener("rulebook-updated", handler);
      if (timer) clearTimeout(timer);
    };
  }, [slug]);

  function suggestionFor(field: Field) {
    return suggestions.find((s) => s.field === field) ?? null;
  }

  async function act(field: Field, action: "accept" | "dismiss") {
    setBusy(field);
    try {
      const res = await fetch(`/api/games/${slug}/suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, action }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setSuggestions(data.suggestions ?? []);
      if (action === "accept") {
        if (field === "players") setPlayersV(data.value);
        else if (field === "playtimeMinutes") setPlaytimeV(data.value);
        else if (field === "ageRating") setAgeV(data.value);
      }
    } finally {
      setBusy(null);
    }
  }

  function pill(label: string, tone = "latte") {
    return (
      <span
        className={
          tone === "sage"
            ? "rounded-full bg-sage/25 px-3 py-1 text-cocoa dark:text-latte"
            : "rounded-full bg-latte/40 px-3 py-1 text-cocoa dark:bg-cocoa/30 dark:text-latte"
        }
      >
        {label}
      </span>
    );
  }

  function SuggestionChip({ field, s }: { field: Field; s: Suggestion }) {
    const shown =
      field === "players"
        ? `${s.suggested} players`
        : field === "playtimeMinutes"
          ? `~${s.suggested} min`
          : String(s.suggested);
    return (
      <span className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-amberglow/50 bg-amberglow/10 px-2.5 py-1 text-xs text-cocoa dark:border-amberglow/40 dark:bg-amberglow/10 dark:text-latte">
        <span>
          {s.note}{" "}
          <span className="font-semibold">{shown}</span>
        </span>
        <button
          onClick={() => act(field, "accept")}
          disabled={busy !== null}
          className="rounded-md bg-terracotta/90 px-2 py-0.5 font-medium text-cream transition-colors hover:bg-terracotta disabled:opacity-50 dark:text-espresso"
        >
          Accept
        </button>
        <button
          onClick={() => act(field, "dismiss")}
          disabled={busy !== null}
          className="rounded-md border border-latte/60 px-2 py-0.5 text-cocoa transition-colors hover:bg-parchment/60 dark:border-cocoa/50 dark:text-latte dark:hover:bg-cocoa/20"
        >
          Dismiss
        </button>
      </span>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {playersV && (
        <span className="inline-flex items-center gap-2">
          {pill(`${playersV} players`)}
          {suggestionFor("players") && (
            <SuggestionChip field="players" s={suggestionFor("players")!} />
          )}
        </span>
      )}
      {playtimeV && (
        <span className="inline-flex items-center gap-2">
          {pill(`~${playtimeV} min`)}
          {suggestionFor("playtimeMinutes") && (
            <SuggestionChip field="playtimeMinutes" s={suggestionFor("playtimeMinutes")!} />
          )}
        </span>
      )}
      {ageV && (
        <span className="inline-flex items-center gap-2">
          {pill(ageV)}
          {suggestionFor("ageRating") && (
            <SuggestionChip field="ageRating" s={suggestionFor("ageRating")!} />
          )}
        </span>
      )}
      {tagsV.map((tag) => pill(tag, "sage"))}
    </div>
  );
}
