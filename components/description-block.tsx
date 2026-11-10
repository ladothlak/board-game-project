"use client";

import { useEffect, useState } from "react";

const POLL_INTERVAL = 5000;
const MAX_POLLS = 12; // ~60 seconds

/**
 * Shows the game description. If it hasn't been generated yet (the async
 * digest is still running), shows a "brewing" state and polls until the
 * description lands — the page is fully usable in the meantime.
 * Stops polling after 60s and shows a fallback message.
 */
export default function DescriptionBlock({
  slug,
  initialDescription,
}: {
  slug: string;
  initialDescription?: string;
}) {
  const [description, setDescription] = useState(initialDescription ?? "");
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    if (description) return;
    let polls = 0;
    // Nudge the server in case it restarted mid-generation. No-op if a
    // digest is already running or the description exists.
    fetch(`/api/games/${slug}`, { method: "POST" }).catch(() => {});
    const id = setInterval(async () => {
      polls++;
      if (polls > MAX_POLLS) {
        clearInterval(id);
        setGaveUp(true);
        return;
      }
      try {
        const res = await fetch(`/api/games/${slug}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.description) setDescription(data.description);
      } catch {
        /* ignore transient failures */
      }
    }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [description, slug]);

  if (description) {
    return (
      <p className="mt-4 text-base leading-relaxed text-cocoa dark:text-latte">
        {description}
      </p>
    );
  }

  if (gaveUp) {
    return (
      <div className="mt-4 rounded-xl border border-dashed border-latte bg-parchment/40 p-5 text-cocoa dark:border-cocoa/50 dark:bg-nightcard dark:text-latte">
        <p className="text-sm leading-relaxed">
          The description is taking longer than expected. You can explore the
          rulebook in the meantime, or refresh the page to try again.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed border-latte bg-parchment/40 p-5 text-cocoa dark:border-cocoa/50 dark:bg-nightcard dark:text-latte">
      <span className="steam" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <p className="text-sm leading-relaxed">
        The description is still brewing — it will appear here shortly. Feel
        free to explore the rulebook in the meantime.
      </p>
    </div>
  );
}
