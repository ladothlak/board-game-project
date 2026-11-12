"use client";

import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", next ? "#171210" : "#f7f1e6");
    try {
      localStorage.setItem("parlor-theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
    setDark(next);
  }

  return (
    <button
      onClick={toggle}
      aria-pressed={dark}
      aria-label="Evening mode"
      className="rounded-lg border border-latte/70 px-2.5 py-1 text-cocoa transition-colors hover:border-terracotta hover:text-terracotta dark:border-cocoa/50 dark:text-latte dark:hover:border-amberglow dark:hover:text-amberglow"
      title="Toggle the evening shift"
    >
      {dark ? "☾ Evening" : "☀ Daylight"}
    </button>
  );
}
