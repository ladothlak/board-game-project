"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Minimal dialog accessibility: Escape-to-close, initial focus, and
 * focus restoration. Returns a ref to attach to the panel element and
 * a handler for the close path.
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void
) {
  const panelRef = useRef<T>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Save the active element before the modal opens so we can restore focus.
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
    }
  }, [open]);

  // Escape key + initial focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    // Move focus into the panel after render.
    const id = requestAnimationFrame(() => {
      const el = panelRef.current;
      if (!el) return;
      const first = el.querySelector<HTMLElement>(
        "input, button, [tabindex]"
      );
      (first ?? el).focus();
    });
    return () => {
      document.removeEventListener("keydown", onKey);
      cancelAnimationFrame(id);
      // Restore focus to the trigger.
      triggerRef.current?.focus();
    };
  }, [open, onClose]);

  const setTrigger = useCallback(
    (el: HTMLElement | null) => {
      triggerRef.current = el;
    },
    []
  );

  return { panelRef, setTrigger };
}
