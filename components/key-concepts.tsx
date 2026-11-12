"use client";

import { useCallback, useEffect, useState } from "react";

interface Concept {
  name: string;
  pages: number[];
  description: string;
}

interface ConceptsData {
  game: string;
  generatedAt: string | null;
  concepts: Concept[];
}

export default function KeyConcepts({ slug }: { slug: string }) {
  const [data, setData] = useState<ConceptsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Load stored concepts on mount.
  const loadConcepts = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/games/${slug}/concepts`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Server error"))))
      .then(setData)
      .catch(() => setError("Couldn't load concepts right now."))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    loadConcepts();
  }, [loadConcepts]);

  // Re-fetch when the rulebook is updated via the modal.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.slug === slug) loadConcepts();
    };
    window.addEventListener("rulebook-updated", handler);
    return () => window.removeEventListener("rulebook-updated", handler);
  }, [slug, loadConcepts]);

  // Reset to not-loaded state when a new rulebook is uploaded (concepts are
  // not auto-regenerated; the user can trigger generation manually).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.slug === slug) {
        setData(null);
        setLoading(false);
        setError(null);
      }
    };
    window.addEventListener("rulebook-replaced", handler);
    return () => window.removeEventListener("rulebook-replaced", handler);
  }, [slug]);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/games/${slug}/concepts`, {
        method: "POST",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Server responded ${res.status}`);
      }
      const d = await res.json();
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  function jumpToPage(page: number) {
    window.dispatchEvent(new CustomEvent("parlor:jump-page", { detail: page }));
  }

  const concepts = data?.concepts ?? [];

  return (
    <div className="rounded-2xl border border-latte/60 bg-parchment/40 shadow-sm dark:border-cocoa/40 dark:bg-nightcard/60">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-5 text-left"
      >
        <div>
          <h2 className="font-serif text-xl text-espresso dark:text-parchment">
            Key gameplay concepts
          </h2>
          <p className="mt-1 text-sm text-cocoa dark:text-latte">
            Major rulebook elements, linked to their pages.
          </p>
        </div>
        <span className="text-lg text-cocoa/70 dark:text-latte/60" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="border-t border-latte/50 px-5 pb-5 pt-4 dark:border-cocoa/40">
          {loading && concepts.length === 0 && (
            <div className="flex items-center gap-3 py-2">
              <span className="steam" aria-hidden>
                <span></span><span></span><span></span>
              </span>
              <p className="text-sm text-cocoa/80 dark:text-latte/70">
                Brewing concepts…
              </p>
            </div>
          )}

          {concepts.length === 0 && !loading && (
            <div className="flex items-center gap-3">
              <p className="text-sm text-cocoa/80 dark:text-latte/70">
                No concepts generated yet.
              </p>
              <button
                onClick={generate}
                disabled={loading}
                className="flex items-center gap-2 rounded-lg bg-sage/70 px-3 py-1.5 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
              >
                {loading ? (
                  <>
                    <span className="steam" aria-hidden>
                      <span></span><span></span><span></span>
                    </span>
                    Brewing…
                  </>
                ) : (
                  "Generate"
                )}
              </button>
            </div>
          )}

          {concepts.length > 0 && (
            <ul className="space-y-2">
              {concepts.map((c) => (
                <li key={c.name} className="text-sm">
                  <span className="font-medium text-espresso dark:text-parchment">
                    {c.name}
                  </span>
                  <span className="text-cocoa/80 dark:text-latte/70">
                    {" "}{c.description}
                  </span>
                  <span className="ml-2 inline-flex gap-1">
                    {c.pages.map((p) => (
                      <button
                        key={p}
                        onClick={() => jumpToPage(p)}
                        className="rounded-full bg-latte/40 px-2 py-0.5 text-xs text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
                      >
                        p. {p}
                      </button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {concepts.length > 0 && (
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={generate}
                disabled={loading}
                className="flex items-center gap-2 rounded-lg bg-latte/40 px-3 py-1.5 text-sm text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
              >
                {loading ? (
                  <>
                    <span className="steam" aria-hidden>
                      <span></span><span></span><span></span>
                    </span>
                    Brewing…
                  </>
                ) : (
                  "Regenerate"
                )}
              </button>
              {data?.generatedAt && (
                <span className="text-xs text-cocoa/50 dark:text-latte/40">
                  generated {new Date(data.generatedAt).toLocaleDateString()}
                </span>
              )}
            </div>
          )}

          {error && (
            <p className="mt-2 text-sm text-terracotta dark:text-amberglow">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
