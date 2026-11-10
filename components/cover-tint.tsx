"use client";

import { useEffect, useState } from "react";

/**
 * Tints the page background from the game's cover image at runtime.
 * Draws the cover onto a small offscreen canvas, averages its pixels,
 * and exposes the result as a CSS variable consumed by `.tinted`
 * (see globals.css). No colors are precomputed — this runs in the
 * browser every time the page loads.
 */
export default function CoverTint({
  coverSrc,
  children,
}: {
  coverSrc?: string;
  children: React.ReactNode;
}) {
  const [tint, setTint] = useState<string | null>(null);

  useEffect(() => {
    if (!coverSrc) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      let r = 0;
      let g = 0;
      let b = 0;
      const n = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
      }
      const tint = `${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)}`;
      setTint(tint);
      // Also expose on <html> so the header/footer (outside this wrapper)
      // can pick up the tint via CSS.
      document.documentElement.style.setProperty("--tint-rgb", tint);
    };
    img.src = coverSrc;
    return () => {
      cancelled = true;
      document.documentElement.style.removeProperty("--tint-rgb");
    };
  }, [coverSrc]);

  return (
    <div
      className="tinted min-h-full"
      style={tint ? ({ "--tint-rgb": tint } as React.CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}
