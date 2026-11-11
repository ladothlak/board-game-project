"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { GameMeta } from "@/lib/games";
import { useDialog } from "@/hooks/use-dialog";

const PITCHES = [
  "The parlor suggests a table for",
  "Tonight's pour is",
  "The lamp favors",
];

const MOODS = [
  { id: "relaxing", label: "☕ Relaxing" },
  { id: "competitive", label: "⚔️ Competitive" },
  { id: "cooperative", label: "🤝 Cooperative" },
  { id: "heavy", label: "🧠 Heavy" },
  { id: "light", label: "🪶 Light" },
] as const;

type MoodId = (typeof MOODS)[number]["id"];

interface Pick {
  game: GameMeta;
  reason: string[];
  score: number;
}

interface LlmPick {
  slug: string;
  title: string;
  reason: string;
}

function playersFit(playersStr: string | undefined, count: number): boolean | null {
  if (!playersStr) return null;
  const range = playersStr.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (range) return count >= Number(range[1]) && count <= Number(range[2]);
  const single = playersStr.match(/(\d+)/);
  if (single) return count === Number(single[0]);
  return null;
}

function daysSince(iso: string | undefined): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

export default function GameNightPicker({ games }: { games: GameMeta[] }) {
  const [open, setOpen] = useState(false);
  const [players, setPlayers] = useState("");
  const [maxTime, setMaxTime] = useState("");
  const [moods, setMoods] = useState<MoodId[]>([]);
  const [pick, setPick] = useState<Pick | null>(null);
  const [llmPicks, setLlmPicks] = useState<LlmPick[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastPlayed, setLastPlayed] = useState<Record<string, string>>({});
  const { panelRef } = useDialog(open, () => setOpen(false));

  useEffect(() => {
    let cancelled = false;
    fetch("/api/plays")
      .then((r) => (r.ok ? r.json() : { lastPlayed: {} }))
      .then((data) => {
        if (!cancelled) setLastPlayed(data.lastPlayed ?? {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const count = Number(players);
  const cap = Number(maxTime);
  const hasInputs = (Number.isFinite(count) && count > 0) || (Number.isFinite(cap) && cap > 0) || moods.length > 0;

  function toggleMood(id: MoodId) {
    setMoods((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  }

  function scoreGame(g: GameMeta): { score: number; reason: string[] } {
    let score = 0;
    const reason: string[] = [];

    if (Number.isFinite(count) && count > 0) {
      const fit = playersFit(g.players, count);
      if (fit === true) {
        score += 3;
        reason.push(`fits ${count} player${count === 1 ? "" : "s"}`);
      } else if (fit === false) {
        score -= 4;
      } else {
        score += 1;
      }
    }

    if (Number.isFinite(cap) && cap > 0) {
      if (g.playtimeMinutes != null) {
        if (g.playtimeMinutes <= cap) {
          score += 3;
          reason.push(`~${g.playtimeMinutes} min, under your ${cap}`);
        } else {
          score -= 4;
        }
      } else {
        score += 1;
      }
    }

    const days = daysSince(lastPlayed[g.slug]);
    if (days < 7) {
      score -= 2;
      reason.push("played recently");
    } else if (days < 30) {
      score -= 1;
    } else if (Number.isFinite(days)) {
      reason.push(`not played in ${Math.round(days)} days`);
    }

    // Small random tiebreak so repeated picks feel fresh.
    score += Math.random();
    return { score, reason };
  }

  const best = useMemo(() => {
    if (!hasInputs || games.length === 0) return null;
    let top: Pick | null = null;
    for (const g of games) {
      const { score, reason } = scoreGame(g);
      if (!top || score > top.score + 1e-6) {
        top = { game: g, score, reason: reason.length ? reason : ["a solid pick for the table"] };
      }
    }
    return top;
  }, [games, players, maxTime, lastPlayed, hasInputs]);

  if (games.length === 0) return null;

  async function handlePick() {
    setPick(null);
    setLlmPicks(null);

    // If moods are selected, use the LLM finder for richer recommendations.
    if (moods.length > 0) {
      setLoading(true);
      try {
        const parts: string[] = [];
        parts.push(`We're in the mood for something ${moods.join(" and ")}.`);
        if (Number.isFinite(count) && count > 0) parts.push(`${count} players.`);
        if (Number.isFinite(cap) && cap > 0) parts.push(`Under ${cap} minutes.`);
        const query = parts.join(" ");

        const res = await fetch("/api/find-game", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });
        if (res.ok) {
          const data = await res.json();
          setLlmPicks(data.recommendations ?? []);
        } else {
          // Fall back to local scoring.
          setPick(best);
        }
      } catch {
        setPick(best);
      } finally {
        setLoading(false);
      }
    } else {
      setPick(best);
    }
  }

  function closeModal() {
    setOpen(false);
    setPick(null);
    setLlmPicks(null);
    setPlayers("");
    setMaxTime("");
    setMoods([]);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex-1 rounded-lg bg-sage/70 px-4 py-2 text-center text-sm text-espresso transition-colors hover:bg-sage dark:text-parchment"
      >
        🎲 Pick a game
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm [transform:translateZ(0)]"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Pick a game"
            className="w-full max-w-md rounded-2xl border border-latte/60 bg-parchment/90 p-6 shadow-xl dark:border-cocoa/40 dark:bg-nightcard/95"
          >
            <h3 className="font-serif text-xl text-espresso dark:text-parchment">
              Pick a game
            </h3>
            <p className="mt-1 text-sm text-cocoa dark:text-latte">
              Tell me about your night and I&apos;ll suggest a game.
            </p>

            {/* Mood chips */}
            <div className="mt-4">
              <span className="text-xs text-cocoa/70 dark:text-latte/70">Mood</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {MOODS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggleMood(m.id)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      moods.includes(m.id)
                        ? "border-terracotta bg-terracotta/15 text-terracotta dark:border-amberglow dark:bg-amberglow/10 dark:text-amberglow"
                        : "border-latte/60 bg-parchment/40 text-cocoa hover:border-terracotta/50 dark:border-cocoa/50 dark:bg-night dark:text-latte"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-sm text-cocoa dark:text-latte">
                Players
                <input
                  value={players}
                  onChange={(e) => setPlayers(e.target.value)}
                  inputMode="numeric"
                  placeholder="3"
                  className="w-20 rounded-lg border border-latte/70 bg-parchment/60 px-3 py-2 text-sm text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
                />
              </label>
              <label className="flex items-center gap-1.5 text-sm text-cocoa dark:text-latte">
                Max minutes
                <input
                  value={maxTime}
                  onChange={(e) => setMaxTime(e.target.value)}
                  inputMode="numeric"
                  placeholder="90"
                  className="w-24 rounded-lg border border-latte/70 bg-parchment/60 px-3 py-2 text-sm text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
                />
              </label>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={handlePick}
                disabled={!hasInputs || loading}
                className="rounded-lg bg-sage/70 px-4 py-2 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
              >
                {loading ? "Brewing…" : "🎲 Pick"}
              </button>
              <button
                onClick={closeModal}
                className="rounded-lg bg-latte/40 px-4 py-2 text-sm text-cocoa transition-colors hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
              >
                Cancel
              </button>
            </div>

            {/* LLM results (mood-based) */}
            {llmPicks && llmPicks.length > 0 && (
              <div className="fade-up mt-4 space-y-2">
                {llmPicks.map((p) => (
                  <Link
                    key={p.slug}
                    href={`/games/${p.slug}`}
                    className="block rounded-xl border border-latte/60 bg-parchment/60 p-3 text-sm text-cocoa shadow-sm transition-colors hover:border-terracotta/50 dark:border-cocoa/40 dark:bg-night dark:text-latte"
                  >
                    <span className="font-serif text-base text-terracotta dark:text-amberglow">
                      {p.title}
                    </span>
                    <p className="mt-1 text-xs text-cocoa/80 dark:text-latte/70">{p.reason}</p>
                  </Link>
                ))}
              </div>
            )}

            {/* Local scoring result (no moods) */}
            {pick && best && !llmPicks && (
              <div className="fade-up mt-4 rounded-xl border border-latte/60 bg-parchment/60 p-4 text-sm text-cocoa shadow-sm dark:border-cocoa/40 dark:bg-night dark:text-latte">
                <p>
                  {PITCHES[Math.floor(Math.random() * PITCHES.length)]}{" "}
                  <Link
                    href={`/games/${best.game.slug}`}
                    className="font-serif text-base text-terracotta hover:underline dark:text-amberglow"
                  >
                    {best.game.title}
                  </Link>
                  . {best.reason.join(" · ")}.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
