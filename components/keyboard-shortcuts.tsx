"use client";

import { useEffect } from "react";

/**
 * Global keyboard shortcuts:
 *   /              → focus the chat input
 *   Ctrl/⌘ + K     → open the shelf search and focus it
 */
export default function KeyboardShortcuts() {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // Don't intercept while editing text or choosing from a control.
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }

      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const chatInput = document.querySelector<HTMLInputElement>(
          'input[placeholder*="Ask about"]'
        );
        if (chatInput) {
          e.preventDefault();
          chatInput.focus();
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        // Only handle the shortcut on the shelf page, where search exists.
        if (!document.querySelector("[data-parlor-shelf]")) return;
        e.preventDefault();
        const search = document.querySelector<HTMLInputElement>(
          "#parlor-shelf-search"
        );
        if (search) {
          search.focus();
        } else {
          // The find modal isn't mounted yet — ask the shelf to open it.
          window.dispatchEvent(new CustomEvent("parlor:open-find"));
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return null;
}
