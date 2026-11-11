"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/hooks/use-dialog";

interface Props {
  slug: string;
  title: string;
}

/**
 * A small control on a game card that opens a modal offering two ways to
 * take the game off the shelf: hide it (data kept, reversible) or delete it
 * entirely (rulebook, cover, notes and metadata all removed).
 */
export default function RemoveGame({ slug, title }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"hide" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { panelRef } = useDialog(open, () => setOpen(false));

  async function act(mode: "hide" | "delete") {
    setBusy(mode);
    setError(null);
    try {
      const res = await fetch(`/api/games/${slug}/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Server responded ${res.status}`);
      }
      setOpen(false);
      router.refresh(); // the shelf re-renders without this game
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`Remove ${title} from the shelf`}
        title="Remove from shelf"
        className="flex h-7 w-7 items-center justify-center rounded-full border border-latte/60 bg-cream/85 text-cocoa shadow-sm transition-colors hover:bg-terracotta hover:text-cream dark:border-cocoa/50 dark:bg-night/85 dark:text-latte dark:hover:bg-terracotta"
      >
        ×
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-espresso/40 p-4 backdrop-blur-sm [transform:translateZ(0)]"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Remove ${title}`}
            onClick={(e) => e.stopPropagation()}
            className="fade-up w-full max-w-md rounded-2xl border border-latte/70 bg-cream p-6 shadow-xl dark:border-cocoa/50 dark:bg-nightcard"
          >
            <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
              Remove {title}?
            </h2>
            <p className="mt-1 text-sm text-cocoa dark:text-latte">
              Choose how to take it off the shelf.
            </p>

            <div className="mt-4 space-y-3">
              <button
                onClick={() => act("hide")}
                disabled={busy !== null}
                className="w-full rounded-xl border border-latte/60 bg-parchment/50 p-4 text-left transition-colors hover:border-terracotta dark:border-cocoa/50 dark:bg-night"
              >
                <span className="block font-medium text-espresso dark:text-parchment">
                  Remove from the shelf
                </span>
                <span className="mt-1 block text-sm leading-relaxed text-cocoa dark:text-latte">
                  Keeps the rulebook, cover, notes and metadata on disk. You can
                  bring it back anytime.
                </span>
              </button>

              <button
                onClick={() => act("delete")}
                disabled={busy !== null}
                className="w-full rounded-xl border border-terracotta/50 bg-terracotta/10 p-4 text-left transition-colors hover:bg-terracotta/20"
              >
                <span className="block font-medium text-terracotta dark:text-amberglow">
                  Delete everything
                </span>
                <span className="mt-1 block text-sm leading-relaxed text-cocoa dark:text-latte">
                  Permanently removes the rulebook, cover, notes and metadata.
                  This can&apos;t be undone.
                </span>
              </button>
            </div>

            {error && (
              <p className="mt-3 text-sm text-terracotta dark:text-amberglow">{error}</p>
            )}

            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setOpen(false)}
                disabled={busy !== null}
                className="rounded-lg px-4 py-2 text-sm text-cocoa hover:bg-parchment/60 dark:text-latte dark:hover:bg-cocoa/20"
              >
                {busy ? "Working…" : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
