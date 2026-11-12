"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/hooks/use-dialog";

interface Expansion {
  name: string;
  pdf: string;
  inChatContext?: boolean;
}

interface LookupResult {
  title: string;
  players?: string;
  playtimeMinutes?: number;
  ageRating?: string;
  publisherUrl?: string;
  publisherName?: string;
  bggUrl?: string;
  wikiUrl?: string;
  webUrl?: string;
  source?: string;
}

export default function Expansions({
  slug,
  expansions,
}: {
  slug: string;
  expansions: Expansion[];
}) {
  const [open, setOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [sourceMethod, setSourceMethod] = useState<"intellisearch" | "link" | "manual">("intellisearch");
  const [language, setLanguage] = useState<string>("en");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);
  const [pendingPdf, setPendingPdf] = useState<{ url: string; blob: Blob } | null>(null);
  const [dismissedUrls, setDismissedUrls] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [attachedPdf, setAttachedPdf] = useState<File | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { panelRef } = useDialog(modalOpen, () => setModalOpen(false));

  // ─── Drag-and-drop handlers ───
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e: React.DragEvent) => {
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
      }
    }
  };

  // ─── Intellisearch: Lookup ───
  async function handleLookup() {
    const titleInput = nameRef.current?.value?.trim();
    if (!titleInput) return;
    const pubInput = (document.querySelector('input[name="exp-publisher"]') as HTMLInputElement)?.value?.trim() ?? null;
    setLookupLoading(true);
    setError(null);
    setDismissedUrls([]);
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
      setLookupResult(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setLookupLoading(false);
    }
  }

  // ─── Intellisearch: Fetch rulebook ───
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
          isExpansion: true,
          language,
        }),
      });
      if (res.status === 200) {
        const blob = await res.blob();
        const url = res.headers.get("X-Pdf-Url") ?? "";
        setPendingPdf({ url, blob });
      } else {
        const d = await res.json().catch(() => ({}));
        setFetchMsg(d.error ?? "Couldn't find a rulebook automatically.");
      }
    } catch {
      setFetchMsg("Network error — try the Link or Manual option instead.");
    } finally {
      setFetchLoading(false);
    }
  }

  // ─── Dismiss pending PDF ───
  function dismissPendingPdf() {
    if (!pendingPdf) return;
    const dismissed = [...dismissedUrls, pendingPdf.url];
    setDismissedUrls(dismissed);
    setPendingPdf(null);
    if (dismissed.length >= 3) {
      setFetchMsg("No more suggestions — use Link or Manual instead.");
      return;
    }
    handleFetchRulebook();
  }

  // ─── Link: Fetch from URL ───
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
          gameName: nameRef.current?.value?.trim() || undefined,
          publisherName: lookupResult?.publisherName ?? null,
          isExpansion: true,
          language,
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

  // ─── Accept pending PDF ───
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

  // ─── Submit form ───
  async function handleAdd() {
    const name = nameRef.current?.value?.trim();
    if (!name || !attachedPdf) return;

    setSaving(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("name", name);
      form.append("pdf", attachedPdf);
      const res = await fetch(`/api/games/${slug}/expansions`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Server responded ${res.status}`);
      }
      setModalOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  // ─── Remove expansion ───
  async function handleRemove(name: string) {
    try {
      const res = await fetch(`/api/games/${slug}/expansions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) router.refresh();
    } catch {
      /* non-critical */
    }
  }

  // ─── Toggle chat context ───
  async function handleToggleChat(name: string, inChatContext: boolean) {
    try {
      const res = await fetch(`/api/games/${slug}/expansions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, inChatContext }),
      });
      if (res.ok) router.refresh();
    } catch {
      /* non-critical */
    }
  }

  const pdfUrl = (name: string) =>
    `/api/games/${slug}/file?name=${encodeURIComponent(name)}`;

  return (
    <>
      {/* Collapsible section */}
      <section className="mt-10 rounded-2xl border border-latte/60 bg-parchment/40 p-5 dark:border-cocoa/40 dark:bg-nightcard/60">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full items-center justify-between text-left"
        >
          <h2 className="font-serif text-xl text-espresso dark:text-parchment">
            Expansions
            {expansions.length > 0 && (
              <span className="ml-2 rounded-full bg-sage/30 px-2 py-0.5 text-xs text-espresso dark:bg-cocoa/40 dark:text-latte">
                {expansions.length}
              </span>
            )}
          </h2>
          <span className="text-cocoa/60 dark:text-latte/60">{open ? "▾" : "▸"}</span>
        </button>

        {open && (
          <div className="mt-4">
            {expansions.length > 0 && (
              <ul className="space-y-2">
                {expansions.map((exp) => (
                  <li
                    key={exp.name}
                    className="flex items-center justify-between rounded-lg bg-parchment/30 px-3 py-2 text-sm dark:bg-night/40"
                  >
                    <div>
                      <span className="font-medium text-espresso dark:text-parchment">
                        {exp.name}
                      </span>
                      <a
                        href={pdfUrl(exp.pdf)}
                        target="_blank"
                        rel="noopener"
                        className="ml-2 text-xs text-terracotta underline hover:text-espresso dark:text-amberglow dark:hover:text-parchment"
                      >
                        view rules
                      </a>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="flex cursor-pointer items-center gap-1 text-xs text-cocoa/70 dark:text-latte/70">
                        <input
                          type="checkbox"
                          checked={exp.inChatContext ?? false}
                          onChange={(e) => handleToggleChat(exp.name, e.target.checked)}
                          className="h-3.5 w-3.5 rounded accent-terracotta"
                          title="Include in chat context"
                        />
                        chat
                      </label>
                      <button
                        type="button"
                        onClick={() => handleRemove(exp.name)}
                        className="text-xs text-cocoa/60 hover:text-terracotta dark:text-latte/60"
                        title="Remove expansion"
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="mt-3 rounded-lg bg-sage/40 px-3 py-2 text-xs text-espresso transition-colors hover:bg-sage/60 dark:bg-cocoa/30 dark:text-parchment"
            >
              + Add expansion
            </button>
          </div>
        )}
      </section>

      {/* Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm [transform:translateZ(0)]"
          onClick={() => !saving && setModalOpen(false)}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Add an expansion"
            onClick={(e) => e.stopPropagation()}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`fade-up max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border p-6 shadow-xl transition-colors ${
              dragOver
                ? "border-terracotta bg-parchment/80 dark:border-terracotta/60 dark:bg-nightcard/95"
                : "border-latte/60 bg-parchment/90 dark:border-cocoa/40 dark:bg-nightcard/95"
            }`}
          >
            <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
              Add an expansion
            </h2>
            <p className="mt-1 text-sm text-cocoa dark:text-latte">
              Name it, then pick how to get the rulebook.
            </p>

            {/* ─── Name ─── */}
            <div className="mt-4">
              <input
                ref={nameRef}
                type="text"
                placeholder="e.g. Voidseeders"
                aria-label="Expansion name"
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
                  className="mt-1 w-full rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-sm text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
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
                    ? "border-terracotta bg-parchment/60 dark:border-terracotta/60 dark:bg-cocoa/30"
                    : "border-latte/50 bg-parchment/30 dark:border-cocoa/40 dark:bg-night/40"
                }`}
              >
                <p className="text-cocoa dark:text-latte">
                  Drag & drop the rulebook PDF here
                </p>
                <div className="mt-3">
                  <label className="cursor-pointer rounded-lg bg-sage/30 px-3 py-2 text-xs text-espresso transition-colors hover:bg-sage/50 dark:bg-cocoa/30 dark:text-parchment">
                    Choose PDF…
                    <input
                      ref={pdfRef}
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setAttachedPdf(f);
                      }}
                    />
                  </label>
                </div>
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
                  className="flex-1 rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-xs text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
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
                    name="exp-publisher"
                    placeholder="Publisher (optional)"
                    aria-label="Publisher (optional)"
                    className="flex-1 rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-xs text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
                  />
                  <button
                    type="button"
                    onClick={handleLookup}
                    disabled={lookupLoading}
                    aria-label="Look up expansion details"
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
                    className="rounded-lg border border-latte/70 bg-parchment/50 px-2 py-1 text-xs text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
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
                    {lookupResult.bggUrl && (
                      <>{" "}·{" "}<a href={lookupResult.bggUrl} target="_blank" rel="noopener" className="underline hover:text-terracotta">BGG</a></>
                    )}
                    {lookupResult.wikiUrl && (
                      <>{" "}·{" "}<a href={lookupResult.wikiUrl} target="_blank" rel="noopener" className="underline hover:text-terracotta">Wikipedia</a></>
                    )}
                  </div>
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
                    Search for the expansion first, then I&apos;ll try to find the rulebook automatically.
                  </p>
                )}
              </div>
            )}

            {/* ─── Fetch status ─── */}
            {fetchMsg && (
              <p className="mt-2 text-xs text-cocoa dark:text-latte">{fetchMsg}</p>
            )}

            {/* ─── Pending PDF confirmation ─── */}
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

            {error && (
              <p className="mt-3 text-xs text-terracotta">{error}</p>
            )}

            {/* ─── Actions ─── */}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg bg-latte/40 px-4 py-2 text-sm text-cocoa transition-colors hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={saving || !attachedPdf}
                className="rounded-lg bg-sage/70 px-4 py-2 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
              >
                {saving
                  ? attachedPdf
                    ? `Uploading ${(attachedPdf.size / 1024 / 1024).toFixed(1)} MB…`
                    : "Adding…"
                  : "Add expansion"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
