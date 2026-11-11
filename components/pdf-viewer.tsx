"use client";

import { useEffect, useRef, useState } from "react";

interface Bookmark {
  page: number;
  label: string;
}

const ZOOM_LEVELS = [1, 1.5, 2];

export default function PdfViewer({ src, slug, expansionSrcs = [] }: { src: string; slug: string; expansionSrcs?: string[] }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasesRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const docsRef = useRef<{ numPages: number; getPage: (n: number) => Promise<any>; destroy: () => Promise<void> }[]>([]);
  const pendingJumpRef = useRef<number | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [showBookmarkForm, setShowBookmarkForm] = useState(false);
  const [bookmarkLabel, setBookmarkLabel] = useState("");
  const [toc, setToc] = useState<{ page: number; label: string }[]>([]);
  const [showToc, setShowToc] = useState(false);
  const [pdfTheme, setPdfTheme] = useState<"normal" | "sepia" | "dark">("normal");
  // Cache-buster: bumped when the rulebook is replaced so the PDF re-fetches.
  const [version, setVersion] = useState(0);

  // Re-load the PDF when the rulebook is updated via the modal. Reset
  // ready/numPages so the brewing overlay shows during the re-fetch, and
  // bump version so Phase 2 re-rasterizes even if page count is unchanged.
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

  // Phase 1: load all documents (base + expansions).
  useEffect(() => {
    let cancelled = false;
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
        if (cancelled) return;
        docsRef.current = docs;
        setNumPages(docs.reduce((sum, d) => sum + d.numPages, 0));
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load the PDF");
        }
      }
    })();
    return () => {
      cancelled = true;
      // Destroy pdfjs documents to release worker-side state and prevent
      // slow accumulation over repeated rulebook replacements.
      for (const d of docsRef.current) void d.destroy();
      docsRef.current = [];
    };
  }, [effectiveSrc, expansionSrcs]);

  // Phase 2: render every page into the (always-mounted) container. Runs once
  // per document set — pages are rasterized at a fixed high resolution (2×) so
  // that zooming is a pure CSS operation (no re-render needed).
  useEffect(() => {
    if (numPages === 0 || docsRef.current.length === 0) return;
    let cancelled = false;
    (async () => {
      const container = containerRef.current;
      if (!container) return;
      container.innerHTML = "";
      canvasesRef.current.clear();

      // Render at 2× so we can display up to 200% without re-rasterizing.
      const RENDER_SCALE = 2;
      let globalPage = 0;

      for (const doc of docsRef.current) {
        // Fetch all page objects for this document in parallel.
        const pages = await Promise.all(
          Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1))
        );
        if (cancelled) return;

        // Render in batches of 5 so the GPU isn't overwhelmed.
        const BATCH = 5;
        for (let start = 0; start < doc.numPages; start += BATCH) {
          if (cancelled) return;
          const end = Math.min(start + BATCH, doc.numPages);
          const batch: HTMLCanvasElement[] = [];

          await Promise.all(
            pages.slice(start, end).map(async (page, j) => {
              const viewport = page.getViewport({ scale: RENDER_SCALE });
              const canvas = document.createElement("canvas");
              canvas.width = Math.floor(viewport.width);
              canvas.height = Math.floor(viewport.height);
              canvas.className = "pdf-page mx-auto rounded shadow-md";
              canvas.setAttribute("role", "img");
              canvas.setAttribute("aria-label", `Page ${start + j + 1} of the rulebook`);
              const ctx = canvas.getContext("2d");
              if (!ctx) {
                batch[j] = canvas;
                return;
              }
              await page.render({ canvasContext: ctx, viewport }).promise;
              batch[j] = canvas;
            })
          );
          if (cancelled) return;

          // Append in order.
          for (let j = 0; j < batch.length; j++) {
            const canvas = batch[j];
            if (canvas) {
              globalPage++;
              canvasesRef.current.set(globalPage, canvas);
              container.appendChild(canvas);
            }
          }
        }
      }
      if (!cancelled) {
        setReady(true);
        // Execute any queued citation jump now that all canvases exist.
        if (pendingJumpRef.current !== null) {
          const p = pendingJumpRef.current;
          pendingJumpRef.current = null;
          // Small delay so the DOM has settled after appending all canvases.
          requestAnimationFrame(() => jumpTo(p));
        }
      }
    })();
    return () => {
      cancelled = true;
      // Ensure the container is empty before the new run starts. The
      // `cancelled` check after each batch await prevents late appends.
      const c = containerRef.current;
      if (c) c.innerHTML = "";
      canvasesRef.current.clear();
    };
  }, [numPages, version]);

  // Phase 3: apply zoom as a CSS width change (no re-render). The canvases
  // are always 2× pixels wide; we just display them at the chosen fraction.
  // After resizing, scroll back to the page that was in view so the reader
  // doesn't get jolted to the top.
  useEffect(() => {
    if (!ready) return;
    const container = containerRef.current;
    if (!container) return;
    const baseWidth = Math.max(320, container.clientWidth - 24);
    for (const [, canvas] of canvasesRef.current) {
      // Canvas pixels are 2× the natural page width. Display at zoom/2 of
      // pixel width so that zoom=1 → natural size, zoom=2 → full pixel width.
      const displayWidth = baseWidth * zoom;
      canvas.style.width = `${displayWidth}px`;
      canvas.style.maxWidth = "none";
    }
    // Keep the current page in view.
    const canvas = canvasesRef.current.get(currentPage);
    if (canvas) {
      container.scrollTo({ top: Math.max(0, canvas.offsetTop - 64) });
    }
  }, [zoom, ready]);

  // Track which page is nearest the top of the scroll area.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ready) return;
    const onScroll = () => {
      let best = 1;
      let bestDist = Infinity;
      for (const [p, c] of canvasesRef.current) {
        const dist = Math.abs(c.offsetTop - container.scrollTop);
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
      setCurrentPage(best);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => container.removeEventListener("scroll", onScroll);
  }, [ready]);

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
    const canvas = canvasesRef.current.get(page);
    const container = containerRef.current;
    if (canvas && container) {
      // Bring the PDF viewer into view on the outer page (important on mobile
      // where the chat bar is at the bottom and the rulebook is above).
      const rect = container.getBoundingClientRect();
      const windowScrollTarget = rect.top + window.scrollY - 16;
      smoothWindowScroll(Math.max(0, windowScrollTarget));

      // Check if the page is already fully in view — no internal scroll needed.
      const scrollTop = container.scrollTop;
      const viewportHeight = container.clientHeight;
      const pageTop = canvas.offsetTop;
      const pageBottom = pageTop + canvas.offsetHeight;
      if (!(pageTop >= scrollTop && pageBottom <= scrollTop + viewportHeight)) {
        // Center the page in the container viewport.
        const target = pageTop + canvas.offsetHeight / 2 - viewportHeight / 2;
        container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      }
    } else if (!ready) {
      // PDF hasn't finished rendering yet — queue the jump for when it's ready.
      pendingJumpRef.current = page;
    }
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

  // Listen for citation jumps from the chat bar. Attached immediately so
  // that clicks work even while the PDF is still rendering — the jump is
  // queued in pendingJumpRef and executed once the canvas exists.
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
      className={"pdf-stage relative mt-4" + (!ready && !error ? " min-h-64" : "")}
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
        <div className="rounded-xl border border-dashed border-latte bg-parchment/40 p-6 text-center text-cocoa dark:border-cocoa/50 dark:bg-nightcard dark:text-latte">
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

            <span className="hidden text-xs text-cocoa/70 dark:text-latte/60 sm:inline">
              p. {currentPage} of {numPages}
            </span>

            <button
              onClick={() => {
                const url = `${window.location.origin}/games/${slug}?page=${currentPage}`;
                navigator.clipboard.writeText(url);
              }}
              className="rounded-lg bg-latte/40 px-3 py-1.5 text-sm text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
              title="Copy a link to this page"
            >
              🔗 Copy link
            </button>

            <button
              onClick={() => setShowToc((v) => !v)}
              aria-expanded={showToc}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                showToc
                  ? "bg-terracotta text-cream dark:text-espresso"
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
              title="Save a bookmark for this page"
            >
              {showBookmarkForm ? "Cancel" : "＋ Bookmark"}
            </button>
            <button
              onClick={() => {
                const next = pdfTheme === "normal" ? "sepia" : pdfTheme === "sepia" ? "dark" : "normal";
                setPdfTheme(next);
              }}
              className="rounded-lg bg-latte/40 px-3 py-1.5 text-sm text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
              title="Cycle page theme: normal → sepia → dark"
            >
              {pdfTheme === "normal" ? "📄 Normal" : pdfTheme === "sepia" ? "🟤 Sepia" : "🌑 Dark"}
            </button>
            <button
              onClick={toggleFullscreen}
              className="rounded-lg bg-terracotta/90 px-3 py-1.5 text-sm text-cream hover:bg-terracotta dark:text-espresso"
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
                className="flex-1 rounded-lg border border-latte/70 bg-cream/70 px-3 py-1.5 text-sm text-espresso placeholder:text-cocoa/50 focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment"
              />
              <button
                type="submit"
                className="rounded-lg bg-terracotta px-3 py-1.5 text-sm text-cream hover:bg-terracotta/90 dark:text-espresso"
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

          {/* Managed imperatively — React renders no children into it. */}
          <div
            ref={containerRef}
            className="pdf-scroll relative max-h-[70vh] space-y-3 overflow-auto rounded-xl border border-latte/60 bg-parchment/40 p-3 dark:border-cocoa/40 dark:bg-nightcard"
          />
          {!ready && (
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
