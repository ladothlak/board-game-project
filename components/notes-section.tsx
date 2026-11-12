"use client";

import { useEffect, useState } from "react";

export default function NotesSection({ slug, title }: { slug: string; title: string }) {
  const [text, setText] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/notes?slug=${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setText(data.text ?? "");
        setUpdatedAt(data.updatedAt ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/notes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const data = await res.json();
        setUpdatedAt(data.updatedAt);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-latte/60 bg-parchment/40 p-5 shadow-sm dark:border-cocoa/40 dark:bg-nightcard/60">
      <h2 className="font-serif text-xl text-espresso dark:text-parchment">My notes</h2>
      <p className="mt-1 text-sm text-cocoa dark:text-latte">
        Private jottings about {title} — setup tips, house rules, what to remember next time.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!loaded}
        rows={4}
        placeholder="e.g. We skip the optional outbreak rule on our first plays…"
        aria-label={`Notes about ${title}`}
        className="mt-3 w-full rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-sm text-espresso placeholder:text-cocoa/50 focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment dark:placeholder:text-latte/40"
      />
      <div className="mt-2 flex items-center justify-between text-xs text-cocoa dark:text-latte">
        <span>
          {updatedAt ? `Last saved ${new Date(updatedAt).toLocaleString()}` : "Not saved yet"}
        </span>
        <button
          onClick={save}
          disabled={saving || !loaded}
          className="rounded-lg bg-sage/70 px-3 py-1.5 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
        >
          {saving ? "Saving…" : "Save notes"}
        </button>
      </div>
    </div>
  );
}
