"use client";

import { useEffect } from "react";

/**
 * Global keyboard shortcuts:
 *   /        → focus the chat input
 *   Ctrl+K   → focus the search bar (home page)
 */
export default function KeyboardShortcuts() {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Don't intercept when already in an input/textarea.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "/") {
        e.preventDefault();
        const chatInput = document.querySelector<HTMLInputElement>(
          'input[placeholder*="Ask about"]'
        );
        chatInput?.focus();
      }

      if (e.ctrlKey && e.key === "k") {
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[type="search"]'
        );
        searchInput?.focus();
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return null;
}
