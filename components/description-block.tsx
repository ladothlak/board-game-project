"use client";

import { useEffect, useState, useCallback, useRef } from "react";

const POLL_INTERVAL = 5000;
const MAX_POLLS = 12; // ~60 seconds
const SAFETY_NET_INTERVAL = 10_000;

/**
 * Shows the game description. If it hasn't been generated yet (the async
 * digest is still running), shows a "brewing" state and polls until the
 * description lands — the page is fully usable in the meantime.
 * Stops polling after 60s and shows a fallback message.
 *
 * Also listens for the `rulebook-updated` event (dispatched by AddRulebook
 * after a re-digest completes) to pick up a freshly generated description
 * without a page refresh. A safety-net periodic poll covers the case where
 * the modal was closed mid-digest and the event never fired.
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
  // Ref mirrors the current description so the refetch callback can compare
  // without depending on `description` (which would change its identity on
  // every update and reset the safety-net interval).
  const descRef = useRef(description);
  descRef.current = description;

  // Stable refetch: only depends on slug. Uses the ref for comparison so
  // the callback identity never changes after mount.
  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/games/${slug}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.description && data.description !== descRef.current) {
        setDescription(data.description);
      }
    } catch {
      /* ignore */
    }
  }, [slug]);

  // Re-fetch when the rulebook is updated via the modal.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.slug === slug) void refetch();
    };
    window.addEventListener("rulebook-updated", handler);
    return () => window.removeEventListener("rulebook-updated", handler);
  }, [slug, refetch]);

  // Reset to "brewing" state when a new rulebook is uploaded.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.slug === slug) {
        setDescription("");
        setGaveUp(false);
      }
    };
    window.addEventListener("rulebook-replaced", handler);
    return () => window.removeEventListener("rulebook-replaced", handler);
  }, [slug]);

  // Safety-net: periodic poll while the description is empty (brewing state).
  // Stops automatically once the description lands. Restarts when
  // rulebook-replaced resets description to "".
  useEffect(() => {
    if (description) return;
    const id = setInterval(() => void refetch(), SAFETY_NET_INTERVAL);
    return () => clearInterval(id);
  }, [description, refetch]);

  // Initial-load polling: if the description is empty on mount, poll until it
  // arrives (the async digest may still be running).
  const initialMountRef = useRef(true);
  useEffect(() => {
    if (description) return;
    let polls = 0;
    // Nudge the server only on initial mount (not on rulebook-replaced reset).
    if (initialMountRef.current) {
      fetch(`/api/games/${slug}`, { method: "POST" }).catch(() => {});
      initialMountRef.current = false;
    }
    const id = setInterval(async () => {
      polls++;
      if (polls > MAX_POLLS) {
        clearInterval(id);
        setGaveUp(true);
        return;
      }
      try {
        const res = await fetch(`/api/games/${slug}`, { cache: "no-store" });
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
