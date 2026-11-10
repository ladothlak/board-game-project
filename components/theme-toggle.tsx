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
      className="rounded-lg border border-latte/70 px-2.5 py-1 text-cocoa hover:border-terracotta hover:text-terracotta dark:border-cocoa/50 dark:text-latte dark:hover:border-amberglow dark:hover:text-amberglow"
      title="Toggle the evening shift"
    >
      {dark ? "☾ Evening" : "☀ Daylight"}
    </button>
  );
}
