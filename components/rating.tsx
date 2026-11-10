"use client";

import { useEffect, useState } from "react";

export default function Rating({ slug }: { slug: string }) {
  const [stars, setStars] = useState<number | null>(null);
  const [hover, setHover] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/games/${slug}/rating`)
      .then((r) => (r.ok ? r.json() : { stars: null }))
      .then((data) => {
        if (cancelled) return;
        setStars(data.stars ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function setRating(n: number) {
    setStars(n);
    const res = await fetch(`/api/games/${slug}/rating`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stars: n }),
    });
    if (!res.ok) setStars(null);
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-cocoa/80 dark:text-latte/70">Our rating</span>
      <div className="flex" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => {
          const active = hover > 0 ? hover : (stars ?? 0);
          return (
            <button
              key={n}
              onClick={() => loaded && setRating(n)}
              onMouseEnter={() => setHover(n)}
              disabled={!loaded}
              aria-label={`Rate ${n} star${n === 1 ? "" : "s"}`}
              className="text-lg leading-none transition-colors disabled:opacity-40"
            >
              <span className={active >= n ? "text-amberglow" : "text-latte/50 dark:text-cocoa/40"}>
                ★
              </span>
            </button>
          );
        })}
      </div>
      {stars != null && (
        <span className="text-xs text-cocoa/70 dark:text-latte/60">{stars}/5</span>
      )}
    </div>
  );
}
