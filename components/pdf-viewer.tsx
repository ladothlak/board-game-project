"use client";

import { useEffect, useRef, useState } from "react";

interface Bookmark {
  page: number;
  label: string;
}

const ZOOM_LEVELS = [1, 1.5, 2, 2.5, 3];

/** Pages rendered beyond the visible range (each side). */
const BUFFER = 4;
/** Rendered pages are kept alive this far beyond the visible range before eviction. */
const EVICT_BUFFER = 8;
/**
 * Pages rasterized in parallel. Rasterization happens on pdf.js's worker
 * thread (the main thread only composites tiles), so a few more in flight
 * speeds catch-up without hurting scroll responsiveness.
 */
const CONCURRENCY = 5;
/** Gap between pages, matching `space-y-3` (0.75rem). */
const GAP = 12;

/** Natural page size at scale 1 (pdfjs units ≈ px at 72 dpi). */
interface PageGeom {
  w: number;
  h: number;
}

/**
 * Virtualized PDF viewer. Only pages near the viewport are rasterized; the
 * rest of the document is represented by precomputed scroll offsets, so the
 * scrollbar, current-page tracking, and page jumps all work before any page
 * has been rendered. Pages are rendered at display resolution (canvas pixels
 * match CSS size at the current zoom), so text stays crisp at every zoom
 * level while memory stays proportional to the visible window rather than the
 * whole book.
 */
export default function PdfViewer({ src, slug, expansionSrcs = [] }: { src: string; slug: string; expansionSrcs?: string[] }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const docsRef = useRef<any[]>([]);
  /** Per-page geometry; entries are undefined until their batch arrives. */
  const geomRef = useRef<(PageGeom | undefined)[]>([]);
  /** Top offset (CSS px) of each page, 0-based; length numPages + 1. */
  const offsetsRef = useRef<number[]>([]);
  const renderedRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const inFlightRef = useRef<Set<number>>(new Set());
  const pendingJobsRef = useRef<number[]>([]);
  /** Pages already sitting in pendingJobsRef — keeps the queue duplicate-free. */
  const pendingSetRef = useRef<Set<number>>(new Set());
  /** Pages that failed to rasterize; parked so we don't retry them every frame. */
  const failedRef = useRef<Set<number>>(new Set());
  /** Bumped on zoom change / reload so stale rasterizations are dropped. */
  const genRef = useRef(0);
  const baseWidthRef = useRef(320);
  const scrollRafRef = useRef(0);
  const pendingJumpRef = useRef<number | null>(null);

  const [numPages, setNumPages] = useState(0);
  /** Total content height (px) — state so the scroll spacer re-renders on layout changes. */
  const [totalH, setTotalH] = useState(0);
  const [ready, setReady] = useState(false);
  const [hasRendered, setHasRendered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [showBookmarkForm, setShowBookmarkForm] = useState(false);
  const [bookmarkLabel, setBookmarkLabel] = useState("");
  const [toc, setToc] = useState<{ page: number; label: string }[]>([]);
  const [showToc, setShowToc] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [pdfTheme, setPdfTheme] = useState<"normal" | "sepia" | "dark">("normal");
  // Cache-buster: bumped when the rulebook is replaced so the PDF re-fetches.
  const [version, setVersion] = useState(0);

  // Read from a ref inside long-lived closures (scroll handler) so renders
  // always use the current zoom even after the effect's closure went stale.
  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  // Re-load the PDF when the rulebook is updated via the modal. Reset
  // ready/numPages so the brewing overlay shows during the re-fetch, and
  // bump version so Phase 1 re-runs even if page count is unchanged.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.slug === slug) {
        setReady(false);
        setNumPages(0);
        setVersion((v) => v + 1);
      }
    };
    window.addEventListener("rulebook-updated", handler);
    return () => window.removeEventListener("rulebook-updated", handler);
  }, [slug]);

  const effectiveSrc = version > 0 ? `${src}${src.includes("?") ? "&" : "?"}t=${version}` : src;

  // ─── Phase 1: load all documents and stream per-page geometry. ──────────
  // Getting each page's viewport is cheap (no rasterization), so scroll
  // offsets, page tracking, and jumps work long before every page has a real
  // offset. Geometry arrives in batches: the first batch (which covers the
  // initial viewport + buffer) unlocks the first paint immediately; later
  // pages get estimated offsets that are corrected as their real geometry
  // lands, with the reading position anchored so corrections don't jump.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setHasRendered(false);
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString();

        const allSrcs = [effectiveSrc, ...expansionSrcs];
        const docs = await Promise.all(
          allSrcs.map((s) => pdfjs.getDocument(s).promise)
        );
        if (cancelled) {
          for (const d of docs) void d.destroy();
          return;
        }
        docsRef.current = docs;

        // The total page count is known as soon as the documents load.
        const total = docs.reduce((n, d) => n + d.numPages, 0);
        setNumPages(total);

        const geom: (PageGeom | undefined)[] = new Array(total);

        function globalToLocal(g: number): { doc: any; local: number } {
          let docIndex = 0;
          for (const d of docs) {
            if (g < docIndex + d.numPages) return { doc: d, local: g - docIndex + 1 };
            docIndex += d.numPages;
          }
          return { doc: docs[docs.length - 1], local: 1 };
        }

        async function fetchGeometry(start: number, count: number) {
          const jobs = [];
          for (let g = start; g < Math.min(start + count, total); g++) {
            const { doc, local } = globalToLocal(g);
            jobs.push(
              doc.getPage(local).then((page: any) => {
                const v = page.getViewport({ scale: 1 });
                geom[g] = { w: v.width, h: v.height };
                // Release the proxy — we only needed its dimensions.
                page.cleanup();
              })
            );
          }
          await Promise.all(jobs);
        }

        // First batch covers the initial viewport + buffer, so the first
        // paint doesn't wait for the whole book's geometry.
        const FIRST_BATCH = 16;
        const BATCH = 8;
        await fetchGeometry(0, FIRST_BATCH);
        if (cancelled) return;
        geomRef.current = geom;
        computeOffsets();
        setReady(true);

        // Remaining geometry streams in the background while pages are
        // already rasterizing; each batch corrects the estimated offsets.
        for (let start = FIRST_BATCH; start < total; start += BATCH) {
          await fetchGeometry(start, BATCH);
          if (cancelled) return;
          computeOffsets();
          renderWindow();
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load the PDF");
        }
      }
    })();
    return () => {
      cancelled = true;
      genRef.current++;
      for (const d of docsRef.current) void d.destroy();
      docsRef.current = [];
      geomRef.current = [];
      offsetsRef.current = [];
      for (const [, c] of renderedRef.current) c.remove();
      renderedRef.current.clear();
      inFlightRef.current.clear();
      pendingJobsRef.current = [];
      pendingSetRef.current.clear();
      failedRef.current.clear();
    };
  }, [effectiveSrc, expansionSrcs]);

  // ─── Geometry helpers ────────────────────────────────────────────────────

  /**
   * Recompute every page's top offset for the current zoom + container width.
   * Pages whose real geometry hasn't arrived yet get an estimated height
   * (the average aspect ratio of known pages), corrected when it lands.
   */
  function computeOffsets() {
    const geom = geomRef.current;
    if (geom.length === 0) return;
    const container = containerRef.current;
    const w = Math.max(320, (container?.clientWidth ?? 344) - 24);
    baseWidthRef.current = w;
    // Anchor the reading position: as estimates are corrected, keep the page
    // at the top of the viewport where it is.
    const oldOffsets = offsetsRef.current;
    const anchorPage = container && oldOffsets.length > 0 ? pageAtOffset(container.scrollTop) : -1;
    const zoomLevel = zoomRef.current;
    const offs: number[] = [0];
    let knownAR = 0;
    let knownN = 0;
    for (const g of geom) {
      let h: number;
      if (g) {
        h = (g.h / g.w) * w * zoomLevel;
        knownAR += g.h / g.w;
        knownN++;
      } else {
        const ar = knownN > 0 ? knownAR / knownN : 1.4; // A4-ish fallback
        h = ar * w * zoomLevel;
      }
      offs.push(offs[offs.length - 1] + h + GAP);
    }
    offsetsRef.current = offs;
    if (anchorPage >= 0 && container) {
      const delta = offs[anchorPage] - oldOffsets[anchorPage];
      if (Math.abs(delta) > 0.5) container.scrollTop += delta;
    }
    setTotalH(offs[offs.length - 1] - GAP);
  }

  /** Highest 0-based page index whose top offset is ≤ `offset`. */
  function pageAtOffset(offset: number): number {
    const offs = offsetsRef.current;
    let lo = 0;
    let hi = offs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offs[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    // Clamp from the offsets array (numPages + 1 entries), not the state, so
    // this is safe from stale closures in long-lived effect callbacks.
    return Math.min(lo, offs.length - 2);
  }

  function pageHeight(i: number): number {
    const offs = offsetsRef.current;
    return offs[i + 1] - offs[i] - GAP;
  }

  // ─── Phase 2: render the visible window (continuous). ────────────────────

  /** Rasterize one page at display resolution and position it absolutely. */
  async function renderPage(p: number, gen: number) {
    inFlightRef.current.add(p);
    try {
      const docs = docsRef.current;
      let docIndex = 0;
      for (let d = 0; d < docs.length; d++) {
        if (p < docIndex + docs[d].numPages) break;
        docIndex += docs[d].numPages;
      }
      const doc = docs[docIndex];
      const localPage = p - docIndex + 1;
      const page = await doc.getPage(localPage);
      if (gen !== genRef.current) return; // zoom changed or reload started

      const geom = geomRef.current[p];
      if (!geom) return; // geometry batch hasn't landed yet — retry next pass
      const zoomLevel = zoomRef.current;
      // Render at display resolution × devicePixelRatio (capped at 2) so text
      // stays crisp on high-DPI screens. The CSS size stays at the display
      // size, so layout, offsets, and scroll positions are unaffected — only
      // the raster gets denser.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = ((baseWidthRef.current * zoomLevel) / geom.w) * dpr;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      canvas.className = "pdf-page rounded shadow-md";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Page ${p + 1} of the rulebook`);
      // left:0 + right:0 + auto margins centers the canvas when it's narrower
      // than the container, and pins it to the left edge (fully reachable via
      // horizontal scroll) when it's wider at high zoom. translateX(-50%)
      // centering would push the left side off-screen at that point.
      canvas.style.position = "absolute";
      canvas.style.left = "0";
      canvas.style.right = "0";
      canvas.style.marginLeft = "auto";
      canvas.style.marginRight = "auto";
      const ctx = canvas.getContext("2d");
      if (ctx) {
        await page.render({ canvasContext: ctx, viewport }).promise;
      }
      page.cleanup();
      if (gen !== genRef.current) return; // stale — drop without appending

      canvas.style.top = `${offsetsRef.current[p]}px`;
      containerRef.current?.appendChild(canvas);
      renderedRef.current.set(p, canvas);
      setHasRendered(true);
    } catch {
      // A genuine rasterization failure (not a zoom-change/unmount abort,
      // which the gen checks above handle) parks the page so we don't retry
      // it on every scroll frame.
      if (gen === genRef.current) failedRef.current.add(p);
    } finally {
      inFlightRef.current.delete(p);
      // A slot freed up — keep draining even if scrolling has stopped, so
      // the buffer fills in right after the reader pauses.
      pumpRender();
    }
  }

  /**
   * Start up to CONCURRENCY more renders from the pending queue, pulling
   * the pages closest to the viewport first so fast scrolling fills in what
   * is on screen before the periphery.
   */
  function pumpRender() {
    const gen = genRef.current;
    const container = containerRef.current;
    if (container && pendingJobsRef.current.length > 1) {
      const center = container.scrollTop + container.clientHeight / 2;
      pendingJobsRef.current.sort(
        (a, b) =>
          Math.abs(offsetsRef.current[a] + pageHeight(a) / 2 - center) -
          Math.abs(offsetsRef.current[b] + pageHeight(b) / 2 - center)
      );
    }
    while (inFlightRef.current.size < CONCURRENCY && pendingJobsRef.current.length > 0) {
      const p = pendingJobsRef.current.shift()!;
      pendingSetRef.current.delete(p);
      void renderPage(p, gen);
    }
  }

  /** Render the pages around the viewport; evict the far ones. */
  function renderWindow() {
    const container = containerRef.current;
    // No `ready` guard here: this is called from the Phase 1 geometry loop,
    // whose closure captured a render where ready was still false. The
    // offsets array is the authoritative "geometry landed" signal — it is
    // populated by computeOffsets() before setReady(true) and reset on
    // cleanup — so it guards equally well without the stale-closure risk.
    if (!container || offsetsRef.current.length === 0) return;
    // Total page count from the offsets array (numPages + 1 entries), not the
    // state, so this is safe from stale closures in long-lived callbacks.
    const total = offsetsRef.current.length - 1;
    const scrollTop = container.scrollTop;
    const viewH = container.clientHeight;
    const first = pageAtOffset(scrollTop);
    const last = Math.min(total - 1, pageAtOffset(scrollTop + viewH));
    const lo = Math.max(0, first - BUFFER);
    const hi = Math.min(total - 1, last + BUFFER);

    // Evict rendered pages far outside the window to bound memory.
    const evLo = lo - EVICT_BUFFER;
    const evHi = hi + EVICT_BUFFER;
    for (const [p, canvas] of renderedRef.current) {
      if (p < evLo || p > evHi) {
        canvas.remove();
        renderedRef.current.delete(p);
      }
    }

    // Queue missing pages. Pages already queued (pendingSetRef) are skipped —
    // without this the queue fills with duplicates on every scroll frame and
    // distant pages wait behind a backlog of redundant rasterizations. Pages
    // whose geometry hasn't arrived yet can't be rasterized; they get picked
    // up when the next geometry batch lands.
    const missing: number[] = [];
    for (let p = lo; p <= hi; p++) {
      if (
        geomRef.current[p] &&
        !renderedRef.current.has(p) &&
        !inFlightRef.current.has(p) &&
        !pendingSetRef.current.has(p) &&
        !failedRef.current.has(p)
      ) {
        missing.push(p);
      }
    }
    for (const p of missing) pendingSetRef.current.add(p);
    pendingJobsRef.current.push(...missing);
    pumpRender();
  }

  /** rAF-throttled entry point for scroll-driven renders. */
  function scheduleRender() {
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      renderWindow();
    });
  }

  // Initial render + re-render on zoom change. On zoom change the old
  // canvases are at the wrong resolution, so they're dropped and the visible
  // window is rasterized fresh (only ~a dozen pages — fast).
  useEffect(() => {
    if (!ready) return;
    genRef.current++;
    for (const [, canvas] of renderedRef.current) canvas.remove();
    renderedRef.current.clear();
    inFlightRef.current.clear();
    pendingJobsRef.current = [];
    pendingSetRef.current.clear();
    failedRef.current.clear();
    computeOffsets();
    const container = containerRef.current;
    if (container) {
      // Keep the current page in view.
      const top = offsetsRef.current[currentPage - 1] ?? 0;
      container.scrollTop = Math.max(0, top - 64);
    }
    renderWindow();
    // Execute any queued citation jump now that offsets are fresh.
    if (pendingJumpRef.current !== null) {
      const p = pendingJumpRef.current;
      pendingJumpRef.current = null;
      requestAnimationFrame(() => jumpTo(p));
    }
  }, [zoom, ready]);

  // Track which page is nearest the top of the scroll area — from the
  // precomputed offsets (no DOM reads per scroll event).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ready) return;
    const onScroll = () => {
      scheduleRender();
      const s = container.scrollTop;
      const i = pageAtOffset(s);
      const dCur = Math.abs(offsetsRef.current[i] - s);
      const dNext =
        i + 1 < offsetsRef.current.length ? Math.abs(offsetsRef.current[i + 1] - s) : Infinity;
      setCurrentPage((dCur <= dNext ? i : i + 1) + 1);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = 0;
    };
  }, [ready]);

  // Re-layout when the container resizes (fullscreen toggle, window resize).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ready) return;
    const ro = new ResizeObserver(() => {
      computeOffsets();
      renderWindow();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [ready, zoom]);

  // Load this game's bookmarks.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/games/${slug}/bookmarks`)
      .then((r) => (r.ok ? r.json() : { bookmarks: [] }))
      .then((data) => {
        if (!cancelled) setBookmarks(data.bookmarks ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Load the per-page table of contents (labels from the rulebook text).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/games/${slug}/toc`)
      .then((r) => (r.ok ? r.json() : { toc: [] }))
      .then((data) => {
        if (!cancelled) setToc(data.toc ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const tocLabel = (p: number) => toc.find((t) => t.page === p)?.label;

  // Smooth-scroll the outer window to a target Y over ~100 ms.
  function smoothWindowScroll(targetY: number) {
    const startY = window.scrollY;
    const diff = targetY - startY;
    if (Math.abs(diff) < 2) return; // already there
    const duration = 100;
    const start = performance.now();
    function step(now: number) {
      const t = Math.min(1, (now - start) / duration);
      // Ease-out: fast start, gentle landing.
      const eased = 1 - (1 - t) * (1 - t);
      window.scrollTo(0, startY + diff * eased);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function jumpTo(page: number) {
    const container = containerRef.current;
    if (!container || !ready || offsetsRef.current.length === 0) {
      // Offsets aren't ready yet — queue the jump for when they are.
      pendingJumpRef.current = page;
      return;
    }
    // Bring the PDF viewer into view on the outer page (important on mobile
    // where the chat bar is at the bottom and the rulebook is above).
    const rect = container.getBoundingClientRect();
    smoothWindowScroll(Math.max(0, rect.top + window.scrollY - 16));

    // Center the page in the container viewport. Works even if the page
    // hasn't been rendered yet — the render loop fills it in as it appears.
    const i = page - 1;
    const target = offsetsRef.current[i] + pageHeight(i) / 2 - container.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }

  function changeZoom(direction: -1 | 1) {
    setZoom((z) => {
      const idx = ZOOM_LEVELS.indexOf(z);
      if (idx === -1) return 1; // not a known level, reset to 100%
      const next = idx + direction;
      if (next < 0 || next >= ZOOM_LEVELS.length) return z; // at a boundary
      return ZOOM_LEVELS[next];
    });
  }

  // Track fullscreen state (Escape exits natively).
  useEffect(() => {
    const handler = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  function toggleFullscreen() {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }

  async function saveBookmark() {
    const label = bookmarkLabel.trim() || `Page ${currentPage}`;
    setShowBookmarkForm(false);
    setBookmarkLabel("");
    const res = await fetch(`/api/games/${slug}/bookmarks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: currentPage, label }),
    });
    if (res.ok) setBookmarks((await res.json()).bookmarks);
  }

  async function removeBookmark(page: number) {
    const res = await fetch(`/api/games/${slug}/bookmarks?page=${page}`, { method: "DELETE" });
    if (res.ok) setBookmarks((await res.json()).bookmarks);
  }

  // Ask the chat bar to focus on the current page.
  function askAboutPage() {
    window.dispatchEvent(new CustomEvent("parlor:ask-page", { detail: currentPage }));
  }

  // Copy a deep link to the page currently in view, with brief confirmation.
  function copyPageLink() {
    const url = `${window.location.origin}/games/${slug}?page=${currentPage}`;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied("copied");
        window.setTimeout(() => setCopied("idle"), 1800);
      })
      .catch(() => {
        setCopied("failed");
        window.setTimeout(() => setCopied("idle"), 1800);
      });
  }

  // Listen for citation jumps from the chat bar. Attached immediately so
  // that clicks work even while the PDF is still rendering — the jump is
  // queued in pendingJumpRef and executed once the offsets exist.
  useEffect(() => {
    const handler = (e: Event) => jumpTo((e as CustomEvent<number>).detail);
    window.addEventListener("parlor:jump-page", handler);
    return () => window.removeEventListener("parlor:jump-page", handler);
  }, [ready]);

  // Jump to the page requested in the URL (?page=N).
  useEffect(() => {
    if (!ready) return;
    const p = Number(new URLSearchParams(window.location.search).get("page"));
    if (p >= 1 && p <= numPages) jumpTo(p);
  }, [ready, numPages]);

  return (
    <div
      ref={stageRef}
      className={"pdf-stage relative mt-4" + (!hasRendered && !error ? " min-h-64" : "")}
      style={{
        filter:
          pdfTheme === "sepia"
            ? "sepia(0.6) brightness(0.95)"
            : pdfTheme === "dark"
              ? "invert(0.9)"
              : undefined,
      }}
    >
      {error ? (
        <div className="rounded-xl border border-dashed border-latte bg-parchment/40 p-6 text-center text-cocoa dark:border-cocoa/40 dark:bg-nightcard">
          Could not load the rulebook: {error}
        </div>
      ) : (
        <>
          {/* Toolbar: zoom + page actions, all in normal flow so nothing overlaps
              when the row wraps on small screens. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-latte/60 bg-parchment/50 p-1 dark:border-cocoa/40 dark:bg-nightcard">
              <button
                onClick={() => changeZoom(-1)}
                disabled={zoom <= ZOOM_LEVELS[0]}
                aria-label="Zoom out"
                className="rounded px-2 py-1 text-sm text-cocoa hover:bg-latte/40 disabled:opacity-40 dark:text-latte dark:hover:bg-cocoa/30"
              >
                −
              </button>
              <button
                onClick={() => setZoom(1)}
                className="min-w-16 rounded px-2 py-1 text-sm tabular-nums text-cocoa hover:bg-latte/40 dark:text-latte dark:hover:bg-cocoa/30"
                title="Reset to fit width"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                onClick={() => changeZoom(1)}
                disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
                aria-label="Zoom in"
                className="rounded px-2 py-1 text-sm text-cocoa hover:bg-latte/40 disabled:opacity-40 dark:text-latte dark:hover:bg-cocoa/30"
              >
                +
              </button>
            </div>

            <span className="hidden text-xs text-cocoa/70 dark:text-latte/70 sm:inline">
              p. {currentPage} of {numPages}
            </span>

            <button
              onClick={copyPageLink}
              aria-live="polite"
              className="rounded-lg bg-latte/40 px-3 py-1.5 text-sm text-cocoa transition-colors hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
              title="Copy a link to this page"
            >
              {copied === "copied"
                ? "✓ Copied"
                : copied === "failed"
                  ? "Copy failed"
                  : "🔗 Copy link"}
            </button>

            <button
              onClick={() => setShowToc((v) => !v)}
              aria-expanded={showToc}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                showToc
                  ? "border border-terracotta bg-terracotta/15 text-terracotta dark:border-amberglow dark:bg-amberglow/10 text-amberglow"
                  : "bg-sage/70 text-espresso hover:bg-sage dark:text-parchment"
              }`}
              title="Toggle the table of contents"
            >
              ☰ Contents
            </button>
            <button
              onClick={askAboutPage}
              className="rounded-lg bg-sage/70 px-3 py-1.5 text-sm text-espresso hover:bg-sage dark:text-parchment"
              title="Ask the chat about the page you're looking at"
            >
              ☕ Ask about p. {currentPage}
            </button>
            <button
              onClick={() => setShowBookmarkForm((v) => !v)}
              className="rounded-lg bg-sage/70 px-3 py-1.5 text-sm text-espresso hover:bg-sage dark:text-parchment"
              title="Save a bookmark for the page you're looking at"
            >
              {showBookmarkForm ? "Cancel" : "＋ Bookmark"}
            </button>
            <button
              onClick={() => {
                const next = pdfTheme === "normal" ? "sepia" : pdfTheme === "sepia" ? "dark" : "normal";
                setPdfTheme(next);
              }}
              className="rounded-lg bg-latte/40 px-3 py-1.5 text-sm text-cocoa transition-colors hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
              title="Cycle page theme: normal → sepia → dark"
            >
              {pdfTheme === "normal" ? "📄 Normal" : pdfTheme === "sepia" ? "🟤 Sepia" : "🌑 Dark"}
            </button>
            <button
              onClick={toggleFullscreen}
              className="rounded-lg bg-latte/40 px-3 py-1.5 text-sm text-cocoa transition-colors hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
              title="Toggle fullscreen"
            >
              {isFullscreen ? "✕ Exit fullscreen" : "⛶ Fullscreen"}
            </button>
            <a
              href={src}
              download
              className="rounded-lg bg-sage/80 px-3 py-1.5 text-sm text-espresso hover:bg-sage dark:text-parchment"
              title="Download the rulebook PDF"
            >
              Download PDF
            </a>
          </div>

          {/* Table of contents drawer — every page, labelled where we have text. */}
          {showToc && (
            <div className="mb-3 rounded-lg border border-latte/60 bg-parchment/50 p-2 dark:border-cocoa/40 dark:bg-nightcard">
              <ul className="max-h-56 space-y-0.5 overflow-auto pr-1">
                {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
                  <li key={p}>
                    <button
                      onClick={() => {
                        jumpTo(p);
                        setShowToc(false);
                      }}
                      className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-sm ${
                        p === currentPage
                          ? "bg-terracotta/20 text-espresso dark:bg-terracotta/30 dark:text-parchment"
                          : "text-cocoa hover:bg-latte/40 dark:text-latte dark:hover:bg-cocoa/30"
                      }`}
                    >
                      <span className="w-8 shrink-0 tabular-nums text-xs opacity-70">p. {p}</span>
                      <span className="min-w-0 truncate">{tocLabel(p) ?? ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Inline bookmark form. */}
          {showBookmarkForm && (
            <form
              className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-latte/60 bg-parchment/50 p-2 dark:border-cocoa/40 dark:bg-nightcard"
              onSubmit={(e) => {
                e.preventDefault();
                void saveBookmark();
              }}
            >
              <input
                autoFocus
                value={bookmarkLabel}
                onChange={(e) => setBookmarkLabel(e.target.value)}
                placeholder={`Label for page ${currentPage} (optional)`}
                aria-label="Bookmark label"
                className="flex-1 rounded-lg border border-latte/70 bg-parchment/50 px-3 py-1.5 text-sm text-espresso placeholder:text-cocoa/50 focus:border-terracotta focus:outline-none dark:border-cocoa/70 dark:bg-night dark:text-parchment"
              />
              <button
                type="submit"
                className="rounded-lg bg-sage/70 px-3 py-1.5 text-sm text-espresso hover:bg-sage disabled:opacity-50 dark:text-parchment"
              >
                Save bookmark
              </button>
            </form>
          )}

          {/* Bookmark chips. */}
          {bookmarks.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {bookmarks.map((b) => (
                <span
                  key={b.page}
                  className="flex items-center gap-1 rounded-full bg-latte/40 py-0.5 pl-2 pr-1 text-xs text-cocoa dark:bg-cocoa/30 dark:text-latte"
                >
                  <button onClick={() => jumpTo(b.page)} className="hover:text-terracotta dark:hover:text-amberglow">
                    p. {b.page} · {b.label || "bookmark"}
                  </button>
                  <button
                    onClick={() => void removeBookmark(b.page)}
                    aria-label={`Remove bookmark on page ${b.page}`}
                    className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-terracotta/30"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Managed imperatively — React renders only the scroll spacer into
              it; rendered page canvases are appended absolutely-positioned. */}
          <div
            ref={containerRef}
            className="pdf-scroll relative max-h-[70vh] overflow-auto rounded-xl border border-latte/60 bg-parchment/40 p-3 dark:border-cocoa/40 dark:bg-nightcard"
          >
            {ready && numPages > 0 && (
              <div aria-hidden="true" style={{ height: totalH }} />
            )}
          </div>
          {!hasRendered && !error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-xl bg-parchment/85 text-cocoa dark:bg-nightcard/90 dark:text-latte">
              <span className="steam" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              <p className="text-sm">Brewing the rulebook…</p>
            </div>
          )}

        </>
      )}
    </div>
  );
}
