"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/hooks/use-dialog";

/**
 * Bulk Add — ingest a BGG collection export (CSV) or a pasted list of game
 * names, look them up in bulk to show metadata, then hand the selected games
 * to the server (/api/games/bulk-add), which fetches each rulebook and
 * creates the game in the background. This component polls the job for
 * per-game progress while the modal stays open.
 *
 * Follows the same modal + useDialog pattern as add-game.tsx.
 */

type LookupState = "idle" | "loading" | "found" | "notfound";
// Mirrors the server-side per-game status reported by /api/games/bulk-add/[jobId].
type AddState = "idle" | "pending" | "working" | "added" | "duplicate" | "no_rulebook" | "error";
type Mode = "csv" | "paste";

/** Simple slugification (mirrors app/api/games/route.ts). */
function slugify(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface BulkMeta {
  title?: string;
  players?: string;
  playtimeMinutes?: number;
  ageRating?: string;
  description?: string;
  tags?: string[];
  publisherName?: string;
}

interface BulkItem {
  name: string;
  lookupState: LookupState;
  meta?: BulkMeta;
  addState: AddState;
  note?: string;
}

/**
 * Parse a CSV document into rows of fields, handling quoted fields (which may
 * contain commas) and doubled-quote escapes. BGG collection exports are plain
 * comma-separated with a header row, so this is all we need.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0].trim() !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }

  // Flush the final field/row.
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0].trim() !== "") rows.push(row);
  }

  return rows;
}

/**
 * Extract the Title column from a BGG collection export. Finds the "Title"
 * header (case-insensitive) and pulls that column from each data row. Falls
 * back to the first column if no Title header is present. Dedupes and drops
 * empties.
 */
function extractTitles(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = header.indexOf("title");
  const col = idx >= 0 ? idx : 0;

  const titles: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const t = (rows[i][col] ?? "").trim();
    if (t && !titles.includes(t)) titles.push(t);
  }
  return titles;
}

/** Small inline brewing-steam loader. */
function SteamLine({ label }: { label: string }) {
  return (
    <div className="mt-3 flex items-center justify-center gap-2 text-xs text-cocoa dark:text-latte">
      <span className="steam" aria-hidden>
        <span></span><span></span><span></span>
      </span>
      {label}
    </div>
  );
}

/** Per-game status indicator: steam while pending/working, then a glyph for the outcome. */
function StatusIndicator({ item }: { item: BulkItem }) {
  if (item.addState === "pending" || item.addState === "working" || item.lookupState === "loading") {
    return (
      <span className="steam mt-0.5" aria-hidden>
        <span></span><span></span><span></span>
      </span>
    );
  }
  if (item.addState === "added") {
    return <span className="text-sm text-sage dark:text-amberglow" aria-label="Added">✓</span>;
  }
  if (item.addState === "no_rulebook") {
    return <span className="text-sm text-cocoa/60 dark:text-latte/50" aria-label="No rulebook found">—</span>;
  }
  if (item.addState === "error") {
    return <span className="text-sm text-terracotta dark:text-amberglow" aria-label="Failed">✗</span>;
  }
  if (item.lookupState === "found") {
    return <span className="text-sm text-sage dark:text-amberglow" aria-label="Found">✓</span>;
  }
  return <span className="text-sm text-cocoa/50 dark:text-latte/40" aria-label="Not found">—</span>;
}

export default function BulkAdd({ variant = "shelf", onDone }: { variant?: "shelf" | "inline"; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("csv");
  const [items, setItems] = useState<BulkItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Names that are already on the shelf (matched by slug). Shown as a gray
  // indicator and left deselected by default so duplicates aren't added
  // accidentally.
  const [duplicates, setDuplicates] = useState<Set<string>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");
  // When checked, games without a rulebook are shelved anyway (no PDF).
  const [includeNoRulebook, setIncludeNoRulebook] = useState(false);
  const router = useRouter();
  const { panelRef } = useDialog<HTMLDivElement>(open, () => setOpen(false));

  // True while a bulk-add job is running server-side.
  const adding = jobId !== null;

  // Reset all modal state when the dialog closes (success, cancel, escape, backdrop).
  useEffect(() => {
    if (!open) {
      setMode("csv");
      setItems([]);
      setSelected(new Set());
      setDuplicates(new Set());
      setJobId(null);
      setParsing(false);
      setError(null);
      setPasteText("");
      setIncludeNoRulebook(false);
    }
  }, [open]);

  // Poll the bulk-add job every 5 seconds while it's running, mapping the
  // server's per-game statuses back onto the checklist items. The modal stays
  // open so the user can watch progress; when the job is done we stop polling.
  useEffect(() => {
    if (!jobId) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/games/bulk-add/${jobId}`);
        if (!res.ok) return; // transient failure — keep polling
        const data = await res.json();
        setItems((prev) =>
          prev.map((it) => {
            const r = (data.results ?? []).find((x: { name: string }) => x.name === it.name);
            if (r) return { ...it, addState: r.status as AddState, note: r.error };
            return it;
          })
        );
        if (data.status === "done") {
          setJobId(null);
          router.refresh();
        }
      } catch {
        /* network hiccup — keep polling */
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [jobId, router]);

  function buildItems(titles: string[]): BulkItem[] {
    return titles.map((name) => ({ name, lookupState: "loading" as const, addState: "idle" as const }));
  }

  // Look up all names in one bulk call and map the results back onto the items.
  async function runBulkLookup(names: string[]) {
    // Mark which names are already on the shelf (by slug) so the checklist
    // can show them and keep them deselected by default.
    try {
      const visRes = await fetch("/api/games/visible");
      if (visRes.ok) {
        const visData: { slugs?: string[] } = await visRes.json();
        const slugs = new Set(visData.slugs ?? []);
        setDuplicates(new Set(names.filter((n) => slugs.has(slugify(n)))));
      }
    } catch {
      /* Non-critical: skip the duplicate check */
    }

    try {
      const res = await fetch("/api/games/bulk-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Bulk lookup failed (${res.status})`);
      }
      const data = await res.json();
      const results: Array<BulkMeta & { name: string; found: boolean }> = data.results ?? [];
      setItems((prev) =>
        prev.map((it) => {
          const r = results.find((x) => x.name === it.name);
          if (r && r.found) return { ...it, lookupState: "found" as const, meta: r };
          return { ...it, lookupState: "notfound" as const };
        })
      );
    } catch (e) {
      setItems((prev) => prev.map((it) => ({ ...it, lookupState: "notfound" as const })));
      setError(e instanceof Error ? e.message : "Bulk lookup failed");
    }
  }

  function handleCsvFile(file: File) {
    setParsing(true);
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result ?? "").replace(/^\uFEFF/, ""); // strip BOM
        const titles = extractTitles(parseCsv(text));
        if (titles.length === 0) {
          setError("No game titles found in that CSV. Make sure it's a BGG collection export with a Title column.");
          return;
        }
        setItems(buildItems(titles));
        setSelected(new Set());
        runBulkLookup(titles);
      } catch {
        setError("Couldn't parse that CSV file.");
      } finally {
        setParsing(false);
      }
    };
    reader.onerror = () => {
      setError("Couldn't read that file.");
      setParsing(false);
    };
    reader.readAsText(file);
  }

  function handlePasteSubmit() {
    const titles = pasteText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const unique = [...new Set(titles)];
    if (unique.length === 0) {
      setError("Type at least one game name, one per line.");
      return;
    }
    setItems(buildItems(unique));
    setSelected(new Set());
    runBulkLookup(unique);
  }

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectAllFound() {
    // Duplicates are left out — they're already on the shelf.
    setSelected(
      new Set(
        items
          .filter((it) => it.lookupState === "found" && !duplicates.has(it.name))
          .map((it) => it.name)
      )
    );
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function startOver() {
    setItems([]);
    setSelected(new Set());
    setDuplicates(new Set());
    setError(null);
    setPasteText("");
  }

  function updateItem(name: string, patch: Partial<BulkItem>) {
    setItems((prev) => prev.map((it) => (it.name === name ? { ...it, ...patch } : it)));
  }

  // Hand the selected games to the server, which processes them in the
  // background (paced to stay under external rate limits) and reports
  // per-game progress via polling. The modal stays open while it runs.
  async function handleAddSelected() {
    const toAdd = items.filter((it) => selected.has(it.name));
    if (toAdd.length === 0) return;
    setError(null);
    for (const item of toAdd) updateItem(item.name, { addState: "pending", note: undefined });

    try {
      const res = await fetch("/api/games/bulk-add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          names: toAdd.map((it) => it.name),
          includeNoRulebook,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? `Server responded ${res.status}`);
        for (const item of toAdd) updateItem(item.name, { addState: "idle", note: undefined });
        return;
      }
      const data = await res.json();
      setJobId(data.jobId); // starts the polling loop
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      for (const item of toAdd) updateItem(item.name, { addState: "idle", note: undefined });
    }
  }



  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          variant === "inline"
            ? "rounded-lg px-3 py-1.5 text-xs text-cocoa transition-colors hover:bg-parchment/60 dark:text-latte dark:hover:bg-cocoa/20"
            : "flex-1 rounded-lg bg-sage/70 px-4 py-2 text-center text-sm text-espresso transition-colors hover:bg-sage dark:text-parchment"
        }
      >
        📥 Bulk add
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm [transform:translateZ(0)]"
          onClick={(e) => {
            if (!adding && e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Bulk add games"
            className="fade-up flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-latte/60 bg-parchment/90 p-6 shadow-xl dark:border-cocoa/40 dark:bg-nightcard/95"
          >
            <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
              Bulk add to the shelf
            </h2>
            <p className="mt-1 text-sm text-cocoa dark:text-latte">
              Import your BGG collection or paste a list, then add the ones with rulebooks.
            </p>

            {/* ─── Input phase (no items parsed yet) ─── */}
            {items.length === 0 && (
              <>
                <div className="mt-4 flex gap-1 rounded-lg bg-parchment/50 p-1 dark:bg-night" role="tablist" aria-label="Import method">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "csv"}
                    onClick={() => setMode("csv")}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs transition-colors ${
                      mode === "csv"
                        ? "bg-sage/60 text-espresso dark:bg-cocoa/40 dark:text-parchment"
                        : "text-cocoa hover:bg-parchment/70 dark:text-latte dark:hover:bg-cocoa/20"
                    }`}
                  >
                    CSV upload
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "paste"}
                    onClick={() => setMode("paste")}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs transition-colors ${
                      mode === "paste"
                        ? "bg-sage/60 text-espresso dark:bg-cocoa/40 dark:text-parchment"
                        : "text-cocoa hover:bg-parchment/70 dark:text-latte dark:hover:bg-cocoa/20"
                    }`}
                  >
                    Paste list
                  </button>
                </div>

                {mode === "csv" ? (
                  <div className="mt-4">
                    <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-latte/50 bg-parchment/30 px-4 py-6 text-sm text-cocoa transition-colors hover:border-terracotta/50 dark:border-cocoa/40 dark:bg-night/40 dark:text-latte">
                      <span aria-hidden>📄</span> Choose a BGG collection CSV…
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        aria-label="BGG collection CSV file"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleCsvFile(f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <p className="mt-2 text-xs text-cocoa/60 dark:text-latte/60">
                      Export your collection from BGG (My Collection → Export) and choose the CSV here. Only the Title column is used.
                    </p>
                    {parsing && <SteamLine label="Reading your collection…" />}
                  </div>
                ) : (
                  <div className="mt-4">
                    <textarea
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                      aria-label="Game names, one per line"
                      placeholder={"One game name per line, e.g.\nSpirit Island\nCatan\nWingspan"}
                      rows={6}
                      className="w-full resize-y rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-sm text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
                    />
                    <button
                      type="button"
                      onClick={handlePasteSubmit}
                      disabled={!pasteText.trim()}
                      className="mt-2 w-full rounded-lg bg-sage/70 px-4 py-2 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
                    >
                      Parse list
                    </button>
                  </div>
                )}
              </>
            )}

            {error && items.length === 0 && (
              <p className="mt-3 text-sm text-terracotta dark:text-amberglow">{error}</p>
            )}

            {/* ─── Submitted: confirmation message ─── */}
            {adding ? (
              <div className="mt-6 text-center">
                <SteamLine label="Shelving your games in the background…" />
                <p className="mt-4 text-sm leading-relaxed text-cocoa dark:text-latte">
                  Your rulebooks are being found and shelved quietly in the back room.
                  They&apos;ll appear on the shelf on their own as each one is discovered —
                  no need to wait or refresh.
                </p>
                <button
                  type="button"
                  onClick={() => { setOpen(false); onDone?.(); }}
                  className="mt-5 rounded-lg bg-sage/70 px-6 py-2 text-sm text-espresso transition-colors hover:bg-sage dark:text-parchment"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                {/* ─── Checklist phase (items parsed) ─── */}
                {items.length > 0 && (
                  <>
                    <div className="mt-4 flex items-center justify-between">
                      <span className="text-xs text-cocoa/70 dark:text-latte/70">
                        {selected.size} of {items.length} selected
                      </span>
                      <div className="flex gap-3 text-xs">
                        <button
                          type="button"
                          onClick={selectAllFound}
                          className="text-terracotta hover:underline dark:text-amberglow"
                        >
                          Select all found
                        </button>
                        <button
                          type="button"
                          onClick={clearSelection}
                          className="text-cocoa hover:underline dark:text-latte"
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          onClick={startOver}
                          className="text-cocoa/70 hover:underline disabled:opacity-50 dark:text-latte/70"
                        >
                          Start over
                        </button>
                      </div>
                    </div>

                    {/* Shelf games even when no rulebook is found. */}
                    <label
                      className={`mt-3 flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                        includeNoRulebook
                          ? "border-terracotta/50 bg-parchment/60 dark:bg-cocoa/20"
                          : "border-latte/40 bg-parchment/30 dark:border-cocoa/30 dark:bg-night/40"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={includeNoRulebook}
                        onChange={(e) => setIncludeNoRulebook(e.target.checked)}
                        aria-label="Add to shelf even if no rulebook found"
                        className="mt-0.5 h-4 w-4 accent-terracotta"
                      />
                      <span>
                        <span className="block font-bold text-espresso dark:text-parchment">
                          Add to shelf even if no rulebook found
                        </span>
                        <span className="mt-0.5 block text-cocoa/70 dark:text-latte/60">
                          Games without a rulebook are shelved with empty details —
                          you can add the rulebook later from their page.
                        </span>
                      </span>
                    </label>

                    <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1" aria-label="Game checklist">
                      {items.map((it) => (
                        <li key={it.name}>
                          <label
                            className={`flex items-start gap-3 rounded-lg border px-3 py-2 transition-colors ${
                              selected.has(it.name)
                                ? "border-terracotta/50 bg-parchment/60 dark:bg-cocoa/20"
                                : "border-latte/40 bg-parchment/30 dark:border-cocoa/30 dark:bg-night/40"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(it.name)}
                              onChange={() => toggleSelect(it.name)}
                              aria-label={`Select ${it.name}`}
                              className="mt-0.5 h-4 w-4 accent-terracotta"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-bold text-espresso dark:text-parchment">
                                {it.name}
                              </span>
                              {duplicates.has(it.name) && (
                                <span className="mt-0.5 block text-xs text-cocoa/50 dark:text-latte/40" aria-label="Already on the shelf">
                                  ✓ already on shelf
                                </span>
                              )}
                              {it.lookupState === "found" && it.meta && (
                                <span className="mt-0.5 block text-xs text-cocoa/80 dark:text-latte/70">
                                  {[
                                    it.meta.players && `${it.meta.players} players`,
                                    it.meta.playtimeMinutes ? `~${it.meta.playtimeMinutes} min` : null,
                                    it.meta.ageRating && `Ages ${it.meta.ageRating}`,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              )}
                            </span>
                            <StatusIndicator item={it} />
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {error && items.length > 0 && (
                  <p className="mt-3 text-sm text-terracotta dark:text-amberglow">{error}</p>
                )}

                {/* ─── Footer ─── */}
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded-lg bg-latte/40 px-4 py-2 text-sm text-cocoa transition-colors hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleAddSelected}
                    disabled={selected.size === 0}
                    className="rounded-lg bg-sage/70 px-4 py-2 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
                  >
                    Add selected ({selected.size})
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
