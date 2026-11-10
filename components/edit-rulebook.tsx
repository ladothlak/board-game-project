"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

/**
 * Inline "Edit rulebook" section that sits just above the PDF viewer.
 * Allows uploading a replacement PDF and shows progress while the server
 * re-digests all LLM-generated content (description, search index, concepts,
 * checklist, complexity).
 */
export default function EditRulebook({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [digesting, setDigesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Poll the server for digest completion.
  function pollDigest() {
    setDigesting(true);
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/games/${slug}/rulebook`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.done) {
          clearInterval(interval);
          setDigesting(false);
          setOpen(false);
          router.refresh();
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
  }

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setDragOver(false), []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = Array.from(e.dataTransfer.files).find((f) => f.type === "application/pdf");
    if (file && fileRef.current) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileRef.current.files = dt.files;
      // Auto-submit.
      handleUpload(file);
    }
  }, []);

  async function handleUpload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("pdf", file);
      const res = await fetch(`/api/games/${slug}/rulebook`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Upload failed (${res.status})`);
      }
      // Server started re-digesting in the background.
      pollDigest();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setUploading(false);
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  }

  return (
    <div className="mt-4">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="rounded-lg border border-latte/50 bg-parchment/30 px-3 py-1.5 text-xs text-cocoa transition-colors hover:bg-parchment/60 dark:border-cocoa/40 dark:bg-night/40 dark:text-latte"
        >
          ✏️ Edit rulebook
        </button>
      ) : (
        <div
          className={`rounded-xl border-2 border-dashed p-4 transition-colors ${
            dragOver
              ? "border-terracotta bg-parchment/60"
              : "border-latte/50 bg-parchment/30 dark:border-cocoa/40 dark:bg-night/40"
          }`}
        >
          {digesting ? (
            <div className="text-center">
              <p className="text-sm text-espresso dark:text-parchment">
                ☕ Regenerating content from the new rulebook…
              </p>
              <p className="mt-1 text-xs text-cocoa/70 dark:text-latte/70">
                Description, search index, key concepts, setup checklist, and
                complexity are being rebuilt. This takes a minute or two.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-cocoa dark:text-latte">
                Drop a new rulebook PDF here, or choose one:
              </p>
              <label className="mt-3 inline-block cursor-pointer rounded-lg bg-sage/30 px-4 py-2 text-xs text-espresso transition-colors hover:bg-sage/50 dark:bg-cocoa/30 dark:text-parchment">
                Choose PDF…
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf"
                  onChange={onFileChange}
                  className="hidden"
                />
              </label>

              {uploading && (
                <p className="mt-2 text-xs text-cocoa dark:text-latte">Uploading…</p>
              )}
              {error && (
                <p className="mt-2 text-xs text-terracotta dark:text-amberglow">{error}</p>
              )}

              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setDragOver(false);
                }}
                className="mt-3 rounded-lg px-3 py-1 text-xs text-cocoa hover:bg-parchment/60 dark:text-latte dark:hover:bg-cocoa/20"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
