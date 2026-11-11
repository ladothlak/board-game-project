"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/hooks/use-dialog";
import BulkAdd from "@/components/bulk-add";

interface LookupResult {
  title: string;
  players?: string;
  playtimeMinutes?: number;
  ageRating?: string;
  description?: string;
  tags?: string[];
  publisherUrl?: string;
  publisherName?: string;
  bggUrl?: string;
  wikiUrl?: string;
  webUrl?: string;
  source?: string;
}

/** Simple slugification (mirrors app/api/games/route.ts). */
function slugify(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export default function AddGame() {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [pendingPdf, setPendingPdf] = useState<{ url: string; blob: Blob } | null>(null);
  const [dismissedUrls, setDismissedUrls] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [sourceMethod, setSourceMethod] = useState<"intellisearch" | "link" | "manual">("intellisearch");
  const [language, setLanguage] = useState<string>("en");
  const [attachedPdf, setAttachedPdf] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const pdfRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { panelRef } = useDialog<HTMLFormElement>(open, () => setOpen(false));

  // Clear all modal state when the dialog closes (success, cancel, escape, backdrop).
  useEffect(() => {
    if (!open) {
      setError(null);
      setLookupLoading(false);
      setLookupResult(null);
      setFetchLoading(false);
      setFetchMsg(null);
      setDuplicateWarning(null);
      setPendingPdf(null);
      setDismissedUrls([]);
      setUrlInput("");
      setSourceMethod("intellisearch");
      setLanguage("en");
      setAttachedPdf(null);
      setDragOver(false);
      setSaving(false);
    }
  }, [open]);

  // BGG lookup with fuzzy search + publisher hint
  async function handleLookup() {
    const titleInput = (document.querySelector('input[name="title"]') as HTMLInputElement)?.value?.trim();
    if (!titleInput) return;
    const pubInput = (document.querySelector('input[name="publisher"]') as HTMLInputElement)?.value?.trim() ?? null;
    setLookupLoading(true);
    setError(null);
    setDismissedUrls([]);
    setDuplicateWarning(null);
    try {
      const res = await fetch("/api/games/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: titleInput, publisher: pubInput }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Lookup failed (${res.status})`);
      }
      const data: LookupResult = await res.json();
      setLookupResult(data);

      // Non-blocking check: is this game already on the shelf?
      try {
        const visRes = await fetch("/api/games/visible");
        if (visRes.ok) {
          const visData: { slugs?: string[] } = await visRes.json();
          const slug = slugify(data.title);
          if (slug && (visData.slugs ?? []).includes(slug)) {
            setDuplicateWarning("This game is already on the shelf — you can still add it as a duplicate.");
          }
        }
      } catch {
        /* Non-critical: skip the duplicate check */
      }

      // Auto-fill the form fields.
      const form = document.querySelector("form") as HTMLFormElement;
      if (!form) return;
      const set = (name: string, value: string) => {
        const el = form.elements.namedItem(name) as HTMLInputElement | null;
        if (el && !el.value) el.value = value;
      };
      if (data.players) set("players", data.players);
      if (data.playtimeMinutes) set("playtimeMinutes", String(data.playtimeMinutes));
      if (data.ageRating) set("ageRating", data.ageRating);
      if (data.tags?.length) set("tags", data.tags.join(", "));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setLookupLoading(false);
    }
  }

  // Fetch rulebook from publisher
  async function handleFetchRulebook() {
    if (!lookupResult) return;
    setFetchLoading(true);
    setFetchMsg(null);
    setPendingPdf(null);
    try {
      const res = await fetch("/api/games/fetch-rulebook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publisherUrl: lookupResult.publisherUrl ?? null,
          gameName: lookupResult.title,
          publisherName: lookupResult.publisherName ?? null,
          excludeUrls: dismissedUrls,
          language,
        }),
      });

      if (res.status === 200) {
        // Got a PDF — store it as pending for user confirmation.
        const blob = await res.blob();
        const url = res.headers.get("X-Pdf-Url") ?? "";
        setPendingPdf({ url, blob });
      } else {
        const d = await res.json().catch(() => ({}));
        setFetchMsg(d.error ?? "Couldn't find a rulebook automatically. Drag your copy in instead.");
      }
    } catch {
      setFetchMsg("Network error — try dragging your copy in instead.");
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

    // Limit to 3 follow-up attempts to avoid infinite loops.
    if (dismissed.length >= 3) {
      setFetchMsg("No more suggestions — drag your copy in instead.");
      return;
    }

    // Auto-retry with the dismissed URL excluded.
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
          gameName: lookupResult?.title ?? undefined,
          publisherName: lookupResult?.publisherName ?? null,
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

  // Accept the pending PDF — attach it to the form.
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

  // Drag-and-drop handlers
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setDragOver(false), []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      if (f.type === "application/pdf") {
        setAttachedPdf(f);
        if (pdfRef.current) {
          const dt = new DataTransfer();
          dt.items.add(f);
          pdfRef.current.files = dt.files;
        }
      } else if (f.type.startsWith("image/") && coverRef.current) {
        const dt = new DataTransfer();
        dt.items.add(f);
        coverRef.current.files = dt.files;
      }
    }
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!attachedPdf) {
      setError("Please attach a rulebook PDF before adding the game.");
      return;
    }
    const formEl = e.currentTarget;
    const data = new FormData(formEl);
    // Ensure the PDF from state is included (covers intellisearch/link acceptance).
    data.delete("pdf");
    data.append("pdf", attachedPdf);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/games", { method: "POST", body: data });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Server responded ${res.status}`);
      }
      setOpen(false);
      setLookupResult(null);
      setFetchMsg(null);
      setAttachedPdf(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex-1 rounded-lg bg-terracotta px-4 py-2 text-center text-sm text-cream transition-colors hover:bg-terracotta/90 dark:text-espresso"
      >
        + Add a Game
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-espresso/40 p-4 backdrop-blur-sm [transform:translateZ(0)]"
          onClick={() => !saving && setOpen(false)}
        >
          <form
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Add a game"
            noValidate
            onSubmit={submit}
            onClick={(e) => e.stopPropagation()}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`fade-up w-full max-w-lg rounded-2xl border p-6 shadow-xl transition-colors dark:border-cocoa/50 dark:bg-nightcard ${
              dragOver
                ? "border-terracotta bg-parchment/80"
                : "border-latte/70 bg-cream"
            }`}
          >
            <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
              Add a game to the shelf
            </h2>
            <p className="mt-1 text-sm text-cocoa dark:text-latte">
              Type a name, search for auto-fill, then pick how to get the rulebook.
            </p>

            {/* ─── Title ─── */}
            <div className="mt-4">
              <input
                name="title"
                required
                placeholder="e.g. Spirit Island"
                aria-label="Game title"
                className="w-full rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-sm text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
              />
            </div>

            {/* ─── Rulebook source selector ─── */}
            <div className="mt-4">
              <label className="block">
                <span className="text-xs text-cocoa/70 dark:text-latte/70">Rulebook source</span>
                <select
                  value={sourceMethod}
                  onChange={(e) => setSourceMethod(e.target.value as "intellisearch" | "link" | "manual")}
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
                <p className="text-cocoa dark:text-latte">
                  Drag & drop your PDF and cover photo here
                </p>
                <p className="mt-1 text-xs text-cocoa/60 dark:text-latte/60">
                  .pdf for the rulebook · .jpg/.png for the box photo
                </p>

                {/* Hidden file inputs (still accessible via click) */}
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="cursor-pointer rounded-lg bg-sage/30 px-3 py-2 text-xs text-espresso transition-colors hover:bg-sage/50 dark:bg-cocoa/30 dark:text-parchment">
                    Choose PDF…
                    <input
                      ref={pdfRef}
                      name="pdf"
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setAttachedPdf(f);
                      }}
                    />
                  </label>
                  <label className="cursor-pointer rounded-lg bg-sage/30 px-3 py-2 text-xs text-espresso transition-colors hover:bg-sage/50 dark:bg-cocoa/30 dark:text-parchment">
                    Choose cover…
                    <input
                      ref={coverRef}
                      name="cover"
                      type="file"
                      accept="image/*"
                      className="hidden"
                    />
                  </label>
                </div>

                {/* Show selected file names */}
                {attachedPdf && (
                  <p className="mt-2 text-xs text-sage dark:text-amberglow">
                    ✓ {attachedPdf.name} ({(attachedPdf.size / 1024 / 1024).toFixed(1)} MB)
                  </p>
                )}
                {coverRef.current?.files?.[0] && (
                  <p className="mt-1 text-xs text-sage dark:text-amberglow">
                    ✓ {coverRef.current.files[0].name}
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

            {/* ─── Intellisearch: Search + auto-find ─── */}
            {sourceMethod === "intellisearch" && (
              <div className="mt-3 space-y-2">
                <div className="flex gap-2">
                  <input
                    name="publisher"
                    placeholder="Publisher (optional)"
                    aria-label="Publisher (optional)"
                    className="flex-1 rounded-lg border border-latte/50 bg-parchment/30 px-3 py-2 text-xs text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/40 dark:bg-night dark:text-parchment"
                  />
                  <button
                    type="button"
                    onClick={handleLookup}
                    disabled={lookupLoading}
                    aria-label="Look up game details"
                    className="rounded-lg bg-sage/60 px-3 py-2 text-sm text-espresso transition-colors hover:bg-sage/80 disabled:opacity-50 dark:bg-cocoa/40 dark:text-parchment"
                  >
                    {lookupLoading ? "…" : "🔍"}
                  </button>
                </div>

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

                {lookupResult && (
                  <div className="rounded-lg bg-sage/20 p-2 text-xs text-cocoa dark:bg-cocoa/20 dark:text-latte">
                    <span className="font-medium">
                      Found on{" "}
                      {lookupResult.source === "bgg" ? "BGG" : lookupResult.source === "web" ? "the web" : "Wikipedia"}:
                    </span>{" "}
                    {lookupResult.title}
                    {lookupResult.players && ` · ${lookupResult.players} players`}
                    {lookupResult.playtimeMinutes && ` · ~${lookupResult.playtimeMinutes} min`}
                    {lookupResult.ageRating && ` · Ages ${lookupResult.ageRating}`}
                    {lookupResult.bggUrl && (
                      <>
                        {" "}·{" "}
                        <a
                          href={lookupResult.bggUrl}
                          target="_blank"
                          rel="noopener"
                          className="underline hover:text-terracotta"
                        >
                          BGG page
                        </a>
                      </>
                    )}
                    {lookupResult.wikiUrl && (
                      <>
                        {" "}·{" "}
                        <a
                          href={lookupResult.wikiUrl}
                          target="_blank"
                          rel="noopener"
                          className="underline hover:text-terracotta"
                        >
                          Wikipedia article
                        </a>
                      </>
                    )}
                    {lookupResult.webUrl && (
                      <>
                        {" "}·{" "}
                        <a
                          href={lookupResult.webUrl}
                          target="_blank"
                          rel="noopener"
                          className="underline hover:text-terracotta"
                        >
                          source page
                        </a>
                      </>
                    )}
                  </div>
                )}

                {duplicateWarning && (
                  <p className="mt-1 text-xs text-terracotta/90 dark:text-amberglow/90">
                    ⚠️ {duplicateWarning}
                  </p>
                )}

                {lookupResult ? (
                  <button
                    type="button"
                    onClick={handleFetchRulebook}
                    disabled={fetchLoading}
                    className="w-full rounded-lg bg-sage/40 px-3 py-2 text-xs text-espresso transition-colors hover:bg-sage/60 disabled:opacity-50 dark:bg-cocoa/30 dark:text-parchment"
                  >
                    {fetchLoading
                      ? "📥 Fetching rulebook…"
                      : `📥 Try fetch rulebook${lookupResult.publisherName ? ` from ${lookupResult.publisherName}` : ""}`}
                  </button>
                ) : (
                  <p className="text-xs text-cocoa/60 dark:text-latte/60">
                    Search for the game first, then I&apos;ll try to find the rulebook automatically.
                  </p>
                )}
              </div>
            )}

            {/* ─── Fetch status message ─── */}
            {fetchMsg && (
              <p className="mt-2 text-xs text-cocoa dark:text-latte">{fetchMsg}</p>
            )}

            {/* ─── Pending rulebook confirmation ─── */}
            {pendingPdf && (
              <div className="mt-3 rounded-lg border border-sage/50 bg-sage/10 p-3 text-xs dark:border-cocoa/40 dark:bg-cocoa/20">
                <p className="text-cocoa dark:text-latte">
                  Found a rulebook. Open it to verify, then accept:
                </p>
                <a
                  href={pendingPdf.url}
                  target="_blank"
                  rel="noopener"
                  className="mt-1 block break-all text-sage underline hover:text-terracotta dark:text-amberglow"
                >
                  {pendingPdf.url}
                </a>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={acceptPendingPdf}
                    className="rounded bg-sage/60 px-3 py-1 text-xs text-espresso transition-colors hover:bg-sage/80 dark:bg-cocoa/50 dark:text-parchment"
                  >
                    ✓ Accept this PDF
                  </button>
                  <button
                    type="button"
                    onClick={dismissPendingPdf}
                    className="rounded px-3 py-1 text-xs text-cocoa hover:bg-parchment/60 dark:text-latte dark:hover:bg-cocoa/30"
                  >
                    Dismiss & try next
                  </button>
                </div>
              </div>
            )}

            {/* ─── Metadata fields ─── */}
            <div className="mt-4 space-y-3 text-sm">
              <div className="grid grid-cols-3 gap-3">
                <label className="block">
                  <span className="text-cocoa dark:text-latte">Players</span>
                  <input
                    name="players"
                    placeholder="1–4"
                    className="mt-1 w-full rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
                  />
                </label>
                <label className="block">
                  <span className="text-cocoa dark:text-latte">Playtime (min)</span>
                  <input
                    name="playtimeMinutes"
                    type="number"
                    min={0}
                    placeholder="90"
                    className="mt-1 w-full rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
                  />
                </label>
                <label className="block">
                  <span className="text-cocoa dark:text-latte">Age</span>
                  <input
                    name="ageRating"
                    placeholder="12+"
                    className="mt-1 w-full rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
                  />
                </label>
              </div>

              <label className="block">
                <span className="text-cocoa dark:text-latte">Tags (comma-separated)</span>
                <input
                  name="tags"
                  placeholder="strategy, cooperative"
                  className="mt-1 w-full rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
                />
              </label>
            </div>

            {error && (
              <p className="mt-3 text-sm text-terracotta dark:text-amberglow">{error}</p>
            )}

            <div className="mt-5 flex items-center justify-between gap-2">
              <BulkAdd variant="inline" onDone={() => setOpen(false)} />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={saving}
                  className="rounded-lg px-4 py-2 text-sm text-cocoa hover:bg-parchment/60 dark:text-latte dark:hover:bg-cocoa/20"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-terracotta px-4 py-2 text-sm text-cream transition-colors hover:bg-terracotta/90 disabled:opacity-50 dark:text-espresso"
                >
                  {saving
                    ? attachedPdf
                      ? `Uploading ${(attachedPdf.size / 1024 / 1024).toFixed(1)} MB…`
                      : "Adding…"
                    : "Add to shelf"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
