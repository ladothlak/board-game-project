"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useDialog } from "@/hooks/use-dialog";

interface Props {
  slug: string;
  title: string;
  label?: string;
}

/**
 * "Add a rulebook" button + modal for games that don't have a rulebook yet.
 * Mirrors the add-game modal's source-method UI (Intellisearch / Link / Manual)
 * but omits the title field since the game already exists on the shelf.
 *
 * On success, uploads to /api/games/[slug]/rulebook which triggers the
 * re-digest pipeline (description, search index, concepts, checklist, complexity).
 */
export default function AddRulebook({ slug, title, label = "Add a rulebook" }: Props) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);
  const [pendingPdf, setPendingPdf] = useState<{ url: string; blob: Blob } | null>(null);
  const [dismissedUrls, setDismissedUrls] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [sourceMethod, setSourceMethod] = useState<"intellisearch" | "link" | "manual">("intellisearch");
  const [language, setLanguage] = useState<string>("en");
  const [attachedPdf, setAttachedPdf] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const pdfRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { panelRef } = useDialog<HTMLFormElement>(open, () => setOpen(false));

  // Clear state when modal closes.
  useEffect(() => {
    if (!open) {
      setError(null);
      setFetchLoading(false);
      setFetchMsg(null);
      setPendingPdf(null);
      setDismissedUrls([]);
      setUrlInput("");
      setSourceMethod("intellisearch");
      setLanguage("en");
      setAttachedPdf(null);
      setDragOver(false);
      setUploading(false);
      setDone(false);
    }
  }, [open]);

  // Intellisearch: use the game's existing name to find a rulebook.
  async function handleFetchRulebook() {
    setFetchLoading(true);
    setFetchMsg(null);
    setPendingPdf(null);
    try {
      const res = await fetch("/api/games/fetch-rulebook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameName: title,
          excludeUrls: dismissedUrls,
          language,
        }),
      });

      if (res.status === 200) {
        const blob = await res.blob();
        const url = res.headers.get("X-Pdf-Url") ?? "";
        setPendingPdf({ url, blob });
      } else {
        const d = await res.json().catch(() => ({}));
        setFetchMsg(d.error ?? "Couldn't find a rulebook automatically. Try a direct link or upload manually.");
      }
    } catch {
      setFetchMsg("Network error — try a direct link or upload manually.");
    } finally {
      setFetchLoading(false);
    }
  }

  // Dismiss the pending PDF and auto-retry with the URL excluded.
  function dismissPendingPdf() {
    if (!pendingPdf) return;
    const dismissed = [...dismissedUrls, pendingPdf.url];
    setDismissedUrls(dismissed);
    setPendingPdf(null);

    if (dismissed.length >= 3) {
      setFetchMsg("No more suggestions — try a direct link or upload manually.");
      return;
    }

    handleFetchRulebook();
  }

  // Fetch a PDF directly from a user-provided URL.
  async function handleFetchFromUrl() {
    const url = urlInput.trim();
    if (!url) return;
    setFetchLoading(true);
    setFetchMsg(null);
    setPendingPdf(null);
    try {
      const res = await fetch("/api/games/fetch-rulebook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directUrl: url,
          gameName: title,
        }),
      });

      if (res.status === 200) {
        const blob = await res.blob();
        setPendingPdf({ url, blob });
      } else {
        const d = await res.json().catch(() => ({}));
        setFetchMsg(d.error ?? `Couldn't download from that URL (${res.status}).`);
      }
    } catch {
      setFetchMsg("Network error — check the URL and try again.");
    } finally {
      setFetchLoading(false);
    }
  }

  // Accept the pending PDF — attach it for upload.
  function acceptPendingPdf() {
    if (!pendingPdf) return;
    const file = new File([pendingPdf.blob], "rules.pdf", { type: "application/pdf" });
    setAttachedPdf(file);
    if (pdfRef.current) {
      const dt = new DataTransfer();
      dt.items.add(file);
      pdfRef.current.files = dt.files;
    }
    setPendingPdf(null);
    setFetchMsg("Rulebook attached ✓");
  }

  // Upload the PDF to the server.
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
      // Server started re-digesting in the background. Show confirmation.
      setDone(true);
      setUploading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setUploading(false);
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setAttachedPdf(file);
    }
  }

  // Drag-and-drop handlers
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setDragOver(false), []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = Array.from(e.dataTransfer.files).find((f) => f.type === "application/pdf");
    if (file && pdfRef.current) {
      const dt = new DataTransfer();
      dt.items.add(file);
      pdfRef.current.files = dt.files;
      setAttachedPdf(file);
    }
  }, []);

  function submit() {
    if (!attachedPdf) {
      setError("Please attach a rulebook PDF first.");
      return;
    }
    handleUpload(attachedPdf);
  }

  const modal = open
    ? createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-espresso/40 p-4 backdrop-blur-sm [transform:translateZ(0)]"
          onClick={() => !uploading && !done && setOpen(false)}
        >
          <form
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={`${label} for ${title}`}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            onClick={(e) => e.stopPropagation()}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`fade-up w-full max-w-lg rounded-2xl border p-6 shadow-xl transition-colors dark:border-cocoa/50 dark:bg-nightcard ${
              dragOver ? "border-terracotta bg-parchment/80" : "border-latte/70 bg-cream"
            }`}
          >
            <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
              {label}
            </h2>
            <p className="mt-1 text-sm text-cocoa dark:text-latte">
              Pick how to get the rulebook for {title}.
            </p>

            {/* ─── Rulebook source selector ─── */}
            <div className="mt-4">
              <label className="block">
                <span className="text-xs text-cocoa/70 dark:text-latte/70">Rulebook source</span>
                <select
                  value={sourceMethod}
                  onChange={(e) => setSourceMethod(e.target.value as "intellisearch" | "link" | "manual")}
                  aria-label="Rulebook source"
                  className="mt-1 w-full rounded-lg border border-latte/50 bg-parchment/30 px-3 py-2 text-sm text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/40 dark:bg-night dark:text-parchment"
                >
                  <option value="manual">Manual</option>
                  <option value="link">Link</option>
                  <option value="intellisearch">Intellisearch</option>
                </select>
              </label>
            </div>

            {/* ─── Manual: Drag-and-drop zone ─── */}
            {sourceMethod === "manual" && (
              <div
                className={`mt-3 rounded-xl border-2 border-dashed p-4 text-center text-sm transition-colors ${
                  dragOver
                    ? "border-terracotta bg-parchment/60"
                    : "border-latte/50 bg-parchment/30 dark:border-cocoa/40 dark:bg-night/40"
                }`}
              >
                <p className="text-cocoa dark:text-latte">Drag & drop your PDF here</p>
                <p className="mt-1 text-xs text-cocoa/60 dark:text-latte/60">.pdf for the rulebook</p>

                <label className="mt-3 inline-block cursor-pointer rounded-lg bg-sage/30 px-4 py-2 text-xs text-espresso transition-colors hover:bg-sage/50 dark:bg-cocoa/30 dark:text-parchment">
                  Choose PDF…
                  <input
                    ref={pdfRef}
                    type="file"
                    accept="application/pdf"
                    onChange={onFileChange}
                    className="hidden"
                  />
                </label>

                {attachedPdf && (
                  <p className="mt-2 text-xs text-sage dark:text-amberglow">
                    ✓ {attachedPdf.name} ({(attachedPdf.size / 1024 / 1024).toFixed(1)} MB)
                  </p>
                )}
              </div>
            )}

            {/* ─── Link: Paste a PDF URL ─── */}
            {sourceMethod === "link" && (
              <div className="mt-3 flex gap-2">
                <input
                  type="url"
                  placeholder="Paste a rulebook PDF URL…"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  aria-label="Rulebook PDF URL"
                  className="flex-1 rounded-lg border border-latte/50 bg-parchment/30 px-3 py-2 text-xs text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/40 dark:bg-night dark:text-parchment"
                />
                <button
                  type="button"
                  onClick={handleFetchFromUrl}
                  disabled={fetchLoading || !urlInput.trim()}
                  className="rounded-lg bg-sage/40 px-3 py-2 text-xs text-espresso transition-colors hover:bg-sage/60 disabled:opacity-50 dark:bg-cocoa/30 dark:text-parchment"
                >
                  {fetchLoading ? "…" : "Fetch"}
                </button>
              </div>
            )}

            {/* ─── Intellisearch: Auto-find ─── */}
            {sourceMethod === "intellisearch" && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-cocoa/70 dark:text-latte/70">Language</label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    aria-label="Rulebook language"
                    className="rounded-lg border border-latte/50 bg-parchment/30 px-2 py-1 text-xs text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/40 dark:bg-night dark:text-parchment"
                  >
                    <option value="en">English</option>
                    <option value="de">German</option>
                    <option value="fr">French</option>
                    <option value="it">Italian</option>
                    <option value="es">Spanish</option>
                    <option value="pt">Portuguese</option>
                    <option value="nl">Dutch</option>
                    <option value="sv">Swedish</option>
                    <option value="no">Norwegian</option>
                    <option value="da">Danish</option>
                    <option value="fi">Finnish</option>
                    <option value="pl">Polish</option>
                    <option value="cs">Czech</option>
                    <option value="hu">Hungarian</option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={handleFetchRulebook}
                  disabled={fetchLoading}
                  className="w-full rounded-lg bg-sage/60 px-3 py-2 text-sm text-espresso transition-colors hover:bg-sage/80 disabled:opacity-50 dark:bg-cocoa/40 dark:text-parchment"
                >
                  {fetchLoading ? "Searching…" : "🔍 Find the rulebook"}
                </button>
              </div>
            )}

            {/* ─── Pending PDF confirmation ─── */}
            {pendingPdf && (
              <div className="mt-3 rounded-lg bg-sage/20 p-3 text-xs text-cocoa dark:bg-cocoa/20 dark:text-latte">
                <p>
                  Found: <span className="font-medium break-all">{pendingPdf.url}</span>
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={acceptPendingPdf}
                    className="rounded-lg bg-sage/40 px-3 py-1.5 text-xs text-espresso transition-colors hover:bg-sage/60 dark:bg-cocoa/30 dark:text-parchment"
                  >
                    ✓ Accept
                  </button>
                  <button
                    type="button"
                    onClick={dismissPendingPdf}
                    className="rounded-lg px-3 py-1.5 text-xs text-cocoa hover:bg-parchment/60 dark:text-latte dark:hover:bg-cocoa/20"
                  >
                    Not right — try another
                  </button>
                </div>
              </div>
            )}

            {/* ─── Status messages ─── */}
            <div role="status">
              {fetchMsg && (
                <p className="mt-3 text-xs text-cocoa dark:text-latte">{fetchMsg}</p>
              )}
              {uploading && (
                <p className="mt-2 text-xs text-cocoa dark:text-latte">Uploading…</p>
              )}
              {error && (
                <p className="mt-2 text-xs text-terracotta dark:text-amberglow">{error}</p>
              )}
            </div>

            {/* ─── Confirmation ─── */}
            {done && (
              <div className="mt-4 rounded-lg bg-sage/20 p-4 text-center dark:bg-cocoa/20">
                <p className="text-sm text-espresso dark:text-parchment">
                  ☕ Rulebook shelved!
                </p>
                <p className="mt-1 text-xs text-cocoa/70 dark:text-latte/70">
                  The description, key concepts, setup checklist, and complexity
                  score are brewing in the background. You can head back to the
                  shelf — everything will fill in as it&apos;s ready.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    router.refresh();
                  }}
                  className="mt-3 rounded-lg bg-sage/70 px-5 py-2 text-sm text-espresso transition-colors hover:bg-sage dark:text-parchment"
                >
                  Alright
                </button>
              </div>
            )}

            {/* ─── Actions ─── */}
            {!done && (
              <div className="mt-5 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={uploading}
                  className="rounded-lg px-4 py-2 text-sm text-cocoa hover:bg-parchment/60 dark:text-latte dark:hover:bg-cocoa/20"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!attachedPdf || uploading}
                  className="rounded-lg bg-sage/70 px-4 py-2 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
                >
                  {uploading ? "Working…" : label}
                </button>
              </div>
            )}
          </form>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-latte/50 bg-parchment/30 px-3 py-1.5 text-xs text-cocoa transition-colors hover:bg-parchment/60 dark:border-cocoa/40 dark:bg-night/40 dark:text-latte"
      >
        📖 {label}
      </button>
      {modal}
    </>
  );
}
