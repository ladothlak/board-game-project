"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A tick-off list of the physical setup steps for this game, generated on demand
 * from the rulebook and stored. Collapsed by default so it doesn't take space;
 * the checkmarks are per-session (each time you set up), so they live only in
 * local state and reset on reload. Includes a setup timer.
 */
export default function SetupChecklist({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<string[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());

  // Setup timer
  const [elapsed, setElapsed] = useState(0);
  const [timerRunning, setTimerRunning] = useState(false);
  const startRef = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (timerRunning) {
      startRef.current = Date.now() - elapsed;
      intervalRef.current = setInterval(() => {
        setElapsed(Date.now() - startRef.current);
      }, 1000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [timerRunning]);

  function formatTime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  }

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setSteps(null);
    setDone(new Set());
    setError(null);
    fetch(`/api/games/${slug}/checklist`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Server error"))))
      .then((data) => {
        if (cancelled) return;
        setSteps(data.steps ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded(true);
          setError("Couldn't load the checklist right now.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function generate(force: boolean) {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/games/${slug}/checklist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();
      if (res.ok) {
        setSteps(data.steps);
        setDone(new Set());
      } else {
        setError(data.error ?? "Something went wrong.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setGenerating(false);
    }
  }

  function toggle(i: number) {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  const count = done.size;

  const subtitle =
    steps && steps.length > 0
      ? `Tick these off as you set up — ${count} of ${steps.length} done.`
      : "Generated from the rulebook, so you can set up without re-reading it.";

  return (
    <div className="rounded-2xl border border-latte/60 bg-parchment/40 shadow-sm dark:border-cocoa/40 dark:bg-nightcard/60">
      {/* Collapsible header. */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-5 text-left"
      >
        <div>
          <h2 className="font-serif text-xl text-espresso dark:text-parchment">Setup checklist</h2>
          <p className="mt-1 text-sm text-cocoa dark:text-latte">{subtitle}</p>
        </div>
        <span className="text-lg text-cocoa/70 dark:text-latte/60" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="border-t border-latte/50 px-5 pb-5 pt-4 dark:border-cocoa/40">
          {error && <p className="text-sm text-terracotta dark:text-amberglow">{error}</p>}

          {loaded && !steps && !generating && (
            <button
              onClick={() => generate(false)}
              className="rounded-lg bg-terracotta px-4 py-2 text-sm text-cream transition-colors hover:bg-terracotta/90 dark:text-espresso"
            >
              Generate setup checklist
            </button>
          )}

          {generating && (
            <div className="flex items-center gap-2 text-sm text-cocoa dark:text-latte">
              <span className="steam" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              Reading the rulebook for the setup steps…
            </div>
          )}

          {steps && steps.length > 0 && !generating && (
            <>
              <ul className="space-y-1.5">
                {steps.map((s, i) => (
                  <li key={i}>
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-latte/30 dark:hover:bg-cocoa/20">
                      <input
                        type="checkbox"
                        checked={done.has(i)}
                        onChange={() => toggle(i)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-terracotta"
                      />
                      <span
                        className={`text-sm leading-relaxed ${
                          done.has(i)
                            ? "text-cocoa/60 line-through dark:text-latte/50"
                            : "text-espresso dark:text-parchment"
                        }`}
                      >
                        {s}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => setDone(new Set())}
                  className="rounded-lg bg-latte/40 px-3 py-1.5 text-sm text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte"
                  title="Start the setup over"
                >
                  Reset
                </button>
                <button
                  onClick={() => generate(true)}
                  className="rounded-lg bg-sage/70 px-3 py-1.5 text-sm text-espresso hover:bg-sage dark:text-parchment"
                  title="Regenerate from the rulebook"
                >
                  ↻ Regenerate
                </button>
                <button
                  onClick={() => setTimerRunning(!timerRunning)}
                  className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    timerRunning
                      ? "bg-terracotta text-cream hover:bg-terracotta/90 dark:text-espresso"
                      : "bg-latte/40 text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte"
                  }`}
                  title={timerRunning ? "Pause timer" : "Start setup timer"}
                >
                  {timerRunning ? `⏸ ${formatTime(elapsed)}` : elapsed > 0 ? `▶ ${formatTime(elapsed)}` : "⏱ Start timer"}
                </button>
                {count === steps.length && (
                  <span className="text-sm font-medium text-sage dark:text-amberglow">
                    All set — the table is ready. 🎲
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
