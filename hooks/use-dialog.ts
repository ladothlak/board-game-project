"use client";

import { useCallback, useEffect, useRef } from "react";

// Tracks the currently open dialogs so only the topmost one responds to
// Escape and traps Tab. Nested dialogs (e.g. Add game → Bulk add) otherwise
// close together or fight over focus.
const dialogStack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

/**
 * Minimal dialog accessibility: Escape-to-close, initial focus, focus
 * restoration, and a Tab focus trap. Returns a ref to attach to the panel
 * element and a handler for the close path.
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void
) {
  const panelRef = useRef<T>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const idRef = useRef<symbol>(Symbol("dialog"));
  // Store onClose in a ref so the effect below only re-runs when `open`
  // changes, not on every render (which would steal focus from nested modals).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Save the active element before the modal opens so we can restore focus.
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
    }
  }, [open]);

  // Escape key, focus trap, and initial focus.
  useEffect(() => {
    if (!open) return;
    const id = idRef.current;
    dialogStack.push(id);

    const onKey = (e: KeyboardEvent) => {
      // Only the topmost dialog reacts.
      if (dialogStack[dialogStack.length - 1] !== id) return;
      const panel = panelRef.current;
      if (!panel) return;

      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (e.key !== "Tab") return;
      const focusable = focusableIn(panel);
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? panel.contains(active) : false;

      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    // Move focus into the panel after render.
    const raf = requestAnimationFrame(() => {
      const el = panelRef.current;
      if (!el) return;
      const first = focusableIn(el)[0];
      if (!first) el.setAttribute("tabindex", "-1");
      (first ?? el).focus();
    });

    return () => {
      document.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
      // Remove this dialog from the stack (it may already have been removed).
      const idx = dialogStack.lastIndexOf(id);
      if (idx !== -1) dialogStack.splice(idx, 1);
      // Restore focus to the trigger.
      triggerRef.current?.focus();
    };
  }, [open]);

  const setTrigger = useCallback(
    (el: HTMLElement | null) => {
      triggerRef.current = el;
    },
    []
  );

  return { panelRef, setTrigger };
}
