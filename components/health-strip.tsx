"use client";

import { useEffect, useState } from "react";

interface Health {
  provider: boolean;
  indexMtime: string | null;
  gameCount: number;
}

export default function HealthStrip() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/health");
        if (res.ok) {
          const data: Health = await res.json();
          if (!cancelled) setHealth(data);
        }
      } catch {
        /* ignore transient failures */
      }
    }
    void poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!health) return null;

  const indexDate = health.indexMtime
    ? new Date(health.indexMtime).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "never";

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-cocoa/70 dark:text-latte/60">
      <span className="flex items-center gap-1.5">
        <span
          className={`h-2 w-2 rounded-full ${health.provider ? "bg-sage" : "bg-terracotta"}`}
          aria-hidden
        />
        {health.provider ? "parlor AI online" : "parlor AI offline"}
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden>☕</span>
        {health.gameCount} game{health.gameCount === 1 ? "" : "s"} on the shelf · indexed {indexDate}
      </span>
    </div>
  );
}
