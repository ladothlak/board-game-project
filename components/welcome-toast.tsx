"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "parlor-welcomed";

/**
 * A one-time welcome toast that explains the key features.
 * Shown only on first visit (tracked in localStorage).
 */
export default function WelcomeToast() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) {
        setVisible(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  if (!visible) return null;

  return (
    <div role="status" className="fixed bottom-20 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
      <div className="fade-up rounded-2xl border border-latte/60 bg-parchment/90 p-4 shadow-lg backdrop-blur dark:border-cocoa/40 dark:bg-nightcard/95">
        <h3 className="font-serif text-base text-espresso dark:text-parchment">
          Welcome to the parlor ☕
        </h3>
        <ul className="mt-2 space-y-1 text-sm text-cocoa dark:text-latte">
          <li>• Type <kbd className="rounded bg-latte/40 px-1 text-xs dark:bg-cocoa/30">/</kbd> to jump to chat</li>
          <li>• Press <kbd className="rounded bg-latte/40 px-1 text-xs dark:bg-cocoa/30">Ctrl/⌘ K</kbd> to search the shelf</li>
          <li>• Use the finder to describe your ideal game night</li>
          <li>• Expand the setup checklist before you start playing</li>
        </ul>
        <button
          onClick={dismiss}
          className="mt-3 rounded-lg bg-sage/70 px-3 py-1.5 text-sm text-espresso hover:bg-sage dark:text-parchment"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
