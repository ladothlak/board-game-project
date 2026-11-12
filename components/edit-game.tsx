"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useDialog } from "@/hooks/use-dialog";
import type { GameMeta } from "@/lib/games";

interface Props {
  slug: string;
  game: GameMeta;
}

/**
 * A small pencil button that opens a modal for editing a game's cover photo
 * and metadata (title, description, players, playtime, age rating, tags).
 * Saves by PATCHing /api/games/[slug]; a new cover is POSTed to
 * /api/games/[slug]/cover first when one is selected.
 */
export default function EditGame({ slug, game }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Form state is pre-filled from the current metadata.
  const [title, setTitle] = useState(game.title);
  const [description, setDescription] = useState(game.description ?? "");
  const [players, setPlayers] = useState(game.players ?? "");
  const [playtime, setPlaytime] = useState(
    game.playtimeMinutes != null ? String(game.playtimeMinutes) : ""
  );
  const [ageRating, setAgeRating] = useState(game.ageRating ?? "");
  const [tags, setTags] = useState((game.tags ?? []).join(", "));
  const [coverFile, setCoverFile] = useState<File | null>(null);
  // Values captured when the modal opens. Used to detect which fields the user
  // actually modified, so the PATCH payload only contains changed fields —
  // this avoids clobbering LLM-generated description/tags that the digest
  // pipeline may have written while the modal was open.
  const initialRef = useRef<{
    title: string;
    description: string;
    players: string;
    playtime: string;
    ageRating: string;
    tags: string;
  } | null>(null);

  function openModal() {
    initialRef.current = { title, description, players, playtime, ageRating, tags };
    setOpen(true);
  }
  const router = useRouter();
  const { panelRef } = useDialog<HTMLFormElement>(open, () => setOpen(false));

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim()) {
      setError("The title can't be empty.");
      return;
    }

    // Only include fields the user actually modified, so we don't overwrite
    // metadata (e.g. LLM-generated description/tags) that may have changed
    // since the modal opened. Use null for cleared fields so JSON preserves them.
    const initial = initialRef.current!;
    const payload: Record<string, unknown> = {};
    if (title.trim() !== initial.title) payload.title = title.trim();
    if (description !== initial.description) payload.description = description;
    if (players.trim() !== initial.players) {
      payload.players = players.trim() || null;
    }
    if (playtime !== initial.playtime) {
      payload.playtimeMinutes = playtime === "" ? null : Number(playtime);
    }
    if (ageRating.trim() !== initial.ageRating) {
      payload.ageRating = ageRating.trim() || null;
    }
    if (tags !== initial.tags) {
      payload.tags = tags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    }

    // Nothing changed and no new cover — just close, no request needed.
    if (Object.keys(payload).length === 0 && !coverFile) {
      setOpen(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // Upload the new cover first, then patch the metadata.
      if (coverFile) {
        const form = new FormData();
        form.append("image", coverFile);
        const res = await fetch(`/api/games/${slug}/cover`, { method: "POST", body: form });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error ?? `Cover upload failed (${res.status})`);
        }
      }

      const res = await fetch(`/api/games/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Server responded ${res.status}`);
      }
      setOpen(false);
      router.refresh(); // the page re-renders with the updated metadata
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "mt-1 w-full rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-sm text-espresso focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment";
  const labelClass = "block text-xs text-cocoa/70 dark:text-latte/70";

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        aria-label={`Edit ${game.title}`}
        title="Edit game"
        className="inline-flex items-center gap-1.5 rounded-lg border border-latte/50 bg-parchment/30 px-3 py-1.5 text-xs text-cocoa transition-colors hover:bg-parchment/60 dark:border-cocoa/40 dark:bg-night/40 dark:text-latte"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden
        >
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
        Edit game
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm [transform:translateZ(0)]"
          onClick={() => !saving && setOpen(false)}
        >
          <form
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Edit ${game.title}`}
            noValidate
            onSubmit={handleSave}
            onClick={(e) => e.stopPropagation()}
            className="fade-up flex max-h-[85vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-2xl border border-latte/60 bg-parchment/90 p-6 shadow-xl dark:border-cocoa/40 dark:bg-nightcard/95"
          >
            <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
              Edit {game.title}
            </h2>

            {/* ─── Title ─── */}
            <label className={labelClass}>
              Title
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Game title"
                className={inputClass}
              />
            </label>

            {/* ─── Description ─── */}
            <label className={labelClass}>
              Description
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                aria-label="Game description"
                rows={4}
                className={`${inputClass} resize-y`}
              />
            </label>

            {/* ─── Players / Playtime / Age ─── */}
            <div className="grid grid-cols-3 gap-3">
              <label className={labelClass}>
                Players
                <input
                  value={players}
                  onChange={(e) => setPlayers(e.target.value)}
                  placeholder="1–4"
                  aria-label="Number of players"
                  className={inputClass}
                />
              </label>
              <label className={labelClass}>
                Playtime (min)
                <input
                  value={playtime}
                  onChange={(e) => setPlaytime(e.target.value)}
                  type="number"
                  min={0}
                  placeholder="90"
                  aria-label="Playtime in minutes"
                  className={inputClass}
                />
              </label>
              <label className={labelClass}>
                Age rating
                <input
                  value={ageRating}
                  onChange={(e) => setAgeRating(e.target.value)}
                  placeholder="12+"
                  aria-label="Age rating"
                  className={inputClass}
                />
              </label>
            </div>

            {/* ─── Tags ─── */}
            <label className={labelClass}>
              Tags (comma-separated)
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="strategy, cooperative"
                aria-label="Tags, comma-separated"
                className={inputClass}
              />
            </label>

            {/* ─── Cover photo ─── */}
            <div className="rounded-lg border border-latte/50 bg-parchment/40 p-3 dark:border-cocoa/40 dark:bg-night/40">
              <span className={labelClass}>Cover photo</span>
              <div className="mt-2 flex items-center gap-3">
                <div className="relative h-20 w-28 shrink-0 overflow-hidden rounded-lg border border-latte/50 bg-latte/20 dark:border-cocoa/40 dark:bg-cocoa/20">
                  {game.image ? (
                    <Image
                      src={`/api/games/${slug}/file?name=${encodeURIComponent(game.image)}`}
                      alt={`${game.title} cover`}
                      fill
                      sizes="100%"
                      className="object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center px-2 text-center text-xs text-cocoa/60 dark:text-latte/50">
                      No cover yet
                    </div>
                  )}
                </div>
                <label className="cursor-pointer rounded-lg bg-sage/30 px-4 py-2 text-xs text-espresso transition-colors hover:bg-sage/50 dark:bg-cocoa/30 dark:text-parchment">
                  {coverFile ? `✓ ${coverFile.name}` : "Replace cover…"}
                  <input
                    type="file"
                    accept="image/*"
                    aria-label="New cover image"
                    className="hidden"
                    onChange={(e) => setCoverFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
            </div>

            {error && (
              <p className="text-sm text-terracotta dark:text-amberglow">{error}</p>
            )}

            {/* ─── Footer ─── */}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={saving}
                className="rounded-lg bg-latte/40 px-4 py-2 text-sm text-cocoa transition-colors hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-sage/70 px-4 py-2 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
