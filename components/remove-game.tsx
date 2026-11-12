"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const router = useRouter();
  const { panelRef } = useDialog(open, () => setOpen(false));

  // Always start from the choice step when the dialog is reopened.
  useEffect(() => {
    if (!open) setConfirmDelete(false);
  }, [open]);

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
    } catch {
      setError("Couldn't remove that game right now. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const modal = open
    ? createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm [transform:translateZ(0)]"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Remove ${title}`}
            onClick={(e) => e.stopPropagation()}
            className="fade-up w-full max-w-md rounded-2xl border border-latte/60 bg-parchment/90 p-6 shadow-xl dark:border-cocoa/40 dark:bg-nightcard/95"
          >
            <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
              Remove {title}?
            </h2>
            <p className="mt-1 text-sm text-cocoa dark:text-latte">
              Choose how to take it off the shelf.
            </p>

            {!confirmDelete ? (
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
                  onClick={() => setConfirmDelete(true)}
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
            ) : (
              <div className="mt-4 rounded-xl border border-terracotta/50 bg-terracotta/10 p-4">
                <p className="font-medium text-espresso dark:text-parchment">
                  Delete {title} permanently?
                </p>
                <p className="mt-1 text-sm leading-relaxed text-cocoa dark:text-latte">
                  The rulebook, cover, notes and metadata will be removed. This
                  can&apos;t be undone.
                </p>
                <div className="mt-3 flex items-center justify-end gap-2">
                  <button
                    onClick={() => setConfirmDelete(false)}
                    disabled={busy !== null}
                    className="rounded-lg bg-latte/40 px-3 py-1.5 text-sm text-cocoa transition-colors hover:bg-terracotta/30 disabled:opacity-50 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
                  >
                    Keep it
                  </button>
                  <button
                    onClick={() => act("delete")}
                    disabled={busy !== null}
                    className="rounded-lg bg-terracotta px-3 py-1.5 text-sm text-cream transition-colors hover:bg-terracotta/90 disabled:opacity-50 dark:text-espresso"
                  >
                    {busy === "delete" ? "Deleting…" : "Delete permanently"}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <p className="mt-3 text-sm text-terracotta dark:text-amberglow">{error}</p>
            )}

            {!confirmDelete && (
              <div className="mt-5 flex items-center justify-end gap-3">
                {busy && (
                  <span role="status" className="text-xs text-cocoa/70 dark:text-latte/60">
                    Working…
                  </span>
                )}
                <button
                  onClick={() => setOpen(false)}
                  disabled={busy !== null}
                  className="rounded-lg bg-latte/40 px-4 py-2 text-sm text-cocoa transition-colors hover:bg-terracotta/30 disabled:opacity-50 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`Remove ${title} from the shelf`}
        title="Remove from shelf"
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-latte/60 bg-cream/85 text-cocoa shadow-sm transition-colors hover:border-terracotta/60 hover:bg-terracotta hover:text-cream dark:border-cocoa/50 dark:bg-night/85 dark:text-latte dark:hover:bg-terracotta"
      >
        ×
      </button>
      {modal}
    </>
  );
}
