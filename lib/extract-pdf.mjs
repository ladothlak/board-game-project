import fs from "fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Layout-aware PDF text extraction (issue #70).
 *
 * pdfjs emits one item per glyph run with absolute coordinates; a naive
 * `items.map(item => item.str).join(" ")` destroys reading order in
 * multi-column rulebooks, drops the first character of two-page spreads,
 * and keeps print-shop furniture (running heads, page numbers) in the text.
 * This module reconstructs lines from Y coordinates, reads columns left to
 * right, repairs hyphenation, drops document-wide boilerplate, and uses the
 * PDF outline as section hints when present.
 *
 * Public API: `extractPdfPages(pdfPath): Promise<string[]>` — one string per
 * page; newlines inside a page are fine (build-index flattens them).
 */

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Merge vertical text runs (chars stacked at one X) back into single items. */
function mergeVerticalRuns(items) {
  const out = [];
  let run = null; // { x, lastY, dir, items }
  const flush = () => {
    if (!run) return;
    if (run.items.length >= 4) {
      out.push({
        str: run.items.map((i) => i.str).join(""),
        x: run.items[0].x,
        y: median(run.items.map((i) => i.y)),
        size: Math.max(...run.items.map((i) => i.size)),
        w: 0,
      });
    } else {
      out.push(...run.items);
    }
    run = null;
  };
  for (const item of items) {
    const trimmed = item.str.trim();
    const isChar = trimmed.length > 0 && trimmed.length <= 3;
    const extendsRun =
      run && isChar && Math.abs(item.x - run.x) < 10 &&
      ((run.dir === 0 ? Math.abs(item.y - run.lastY) : (item.y - run.lastY) * run.dir) > 1);
    if (extendsRun) {
      run.items.push(item);
      if (run.dir === 0) run.dir = Math.sign(item.y - run.lastY);
      run.lastY = item.y;
    } else {
      flush();
      if (isChar) run = { x: item.x, lastY: item.y, dir: 0, items: [item] };
      else out.push(item);
    }
  }
  flush();
  return out;
}

/**
 * Detect columns from body-region item ink. A gutter is a vertical band
 * empty of ink in at least half of the horizontal slices (with content on
 * both sides), so columns of unequal height and full-width sections do not
 * mask each other. Per slice, candidate gutters are the gaps between
 * consecutive ink intervals; candidates for the same physical gutter sit
 * within a few points of each other across slices and are clustered by
 * center, needing members in half the slices to qualify. Inter-word gaps and
 * indentation fail the vote count: other lines put ink there in most slices.
 * Gutter width is not the signal (packed multi-column layouts have narrow
 * gutters) — persistence is. Every item's left edge belongs to exactly one
 * column, so no character is ever dropped. */
function detectColumns(items, pageHeight) {
  // Exclude space-only items: they are not ink and can bridge gutters in
  // pdfjs output (wide inter-column spaces), masking real gaps.
  const body = items.filter(
    (i) => i.y / pageHeight > 0.08 && i.y / pageHeight < 0.92 && i.str.trim(),
  );
  if (!body.length) return null;
  const minX = Math.min(...body.map((i) => i.x));
  const maxX = Math.max(...body.map((i) => i.x + i.w));
  const pageWidth = maxX - minX;
  const nSlices = 8;
  const y0 = pageHeight * 0.08;
  const sliceH = (pageHeight * 0.84) / nSlices;
  // Per-slice items.
  const slices = [];
  for (let s = 0; s < nSlices; s++) {
    const sy0 = y0 + s * sliceH;
    const sy1 = sy0 + sliceH;
    slices.push(body.filter((i) => i.y >= sy0 && i.y < sy1));
  }
  // A gutter is a vertical band empty of ink in at least half the slices.
  // Per slice, candidate gutters are the gaps between consecutive ink
  // intervals (each has content on both sides by construction). Candidates
  // from different slices for the same physical gutter sit within a few
  // points of each other, so they are clustered by center; a cluster needs
  // members in most slices (≥75%) to qualify. Inter-word gaps and indentation
  // affect only a few lines and fail the vote count: other lines put ink there
  // in most slices. Real column gutters persist across nearly the full body
  // height. Column gutters can be narrow (packed multi-column layouts), so the
  // candidate width floor is tiny — persistence, not width, is the real signal.
  const needVotes = Math.max(5, Math.ceil(nSlices * 0.75));
  const minGapSmall = Math.max(2, pageWidth * 0.005);
  const candidates = [];
  for (const sItems of slices) {
    const intervals = sItems
      .map((it) => [it.x, it.x + it.w])
      .sort((p, q) => p[0] - q[0]);
    for (let i = 1; i < intervals.length; i++) {
      const a = intervals[i - 1][1];
      const b = intervals[i][0];
      if (b - a >= minGapSmall) candidates.push({ a, b, slice: sItems });
    }
  }
  // Cluster candidates by center position; same-gutter gaps shift < 5pt
  // between slices while distinct gutters are a column width apart.
  const mergeDist = Math.max(10, pageWidth * 0.1);
  const clusters = [];
  for (const c of candidates.sort((p, q) => p.a + p.b - (q.a + q.b))) {
    const cl = clusters.find((cl) => Math.abs(cl.center - (c.a + c.b) / 2) <= mergeDist);
    if (!cl)
      clusters.push({ center: (c.a + c.b) / 2, slices: new Set([c.slice]), a: c.a, b: c.b });
    else {
      cl.slices.add(c.slice);
      cl.a = Math.min(cl.a, c.a);
      cl.b = Math.max(cl.b, c.b);
    }
  }
  const guttersFinal = clusters.filter((cl) => cl.slices.size >= needVotes);
  // Cluster all left edges into columns across the voted gutters.
  const allEdges = [...new Set(body.map((i) => i.x))].sort((a, b) => a - b);
  const columns = [];
  let col = null;
  for (const e of allEdges) {
    const inGutter = guttersFinal.some((g) => e > g.a && e <= g.b);
    if (!col || inGutter) {
      if (col) columns.push(col);
      col = { min: e, max: e };
    } else {
      col.max = Math.max(col.max, e);
    }
  }
  if (col) columns.push(col);
  return { columns, minX, maxX };
}

/** Group items into lines by Y (tolerance scaled to font size), sorted by X. */
function groupLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const lines = [];
  let line = null;
  for (const item of sorted) {
    // Space items are kept: they carry the word separators between text runs.
    const tol = Math.max(2, 0.45 * item.size);
    if (line && item.y >= line.topY - tol) {
      line.items.push(item);
    } else {
      if (line) lines.push(line);
      line = { topY: item.y, items: [item] };
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    // Concatenate in X order: PDFs emit explicit space items between words,
    // so no gap heuristic is needed (it corrupts tight kerning).
    const text = l.items.map((i) => i.str).join("").replace(/[ \t]+/g, " ").trim();
    return {
      y: l.topY,
      xMin: l.items[0].x,
      xMax: Math.max(...l.items.map((i) => i.x + i.w)),
      size: median(l.items.map((i) => i.size)),
      text,
    };
  });
}

function norm(text) {
  return text.trim().replace(/\s+/g, " ").toLowerCase().replace(/\d+/g, "#");
}

/**
 * Document-wide boilerplate: a line is furniture when its text repeats on
 * many pages AT A CONSISTENT POSITION (running heads near the top, footers
 * and page numbers near the bottom). Position consistency keeps legitimate
 * repeated body sentences out of the drop set.
 */
function findBoilerplate(pageData) {
  const counts = new Map(); // norm text -> { pages: Set, pos: number[] }
  for (const [i, { lines, pageHeight }] of pageData.entries()) {
    for (const line of lines) {
      if (!line.text) continue;
      const n = norm(line.text);
      if (!counts.has(n)) counts.set(n, { pages: new Set(), pos: [] });
      const c = counts.get(n);
      c.pages.add(i);
      c.pos.push(line.y / pageHeight);
    }
  }
  const boiler = new Set();
  for (const [n, c] of counts) {
    if (c.pages.size < 3) continue;
    const allTop = c.pos.every((p) => p > 0.8);
    const allBottom = c.pos.every((p) => p < 0.2);
    if (allTop || allBottom) boiler.add(n);
  }
  return boiler;
}

/**
 * Collect outline (bookmark) titles from the PDF, if it has one. Used as
 * section hints: a line matching an outline title gets a paragraph break
 * before it. Most rulebook PDFs have no outline, so this is usually a no-op.
 */
function collectOutlineTitles(doc) {
  const titles = new Set();
  let root;
  try {
    root = doc.getOutline?.() ?? null;
  } catch {
    return titles;
  }
  if (!root || !Array.isArray(root.items)) return titles;
  const walk = (items) => {
    for (const item of items) {
      if (typeof item.title === "string" && item.title.trim()) titles.add(item.title);
      if (Array.isArray(item.items)) walk(item.items);
    }
  };
  walk(root.items);
  return titles;
}

function renderBand(lines, boilerplate, sectionTitles) {
  const kept = lines.filter((l) => l.text && !boilerplate.has(norm(l.text)));
  if (!kept.length) return "";
  const pitches = [];
  for (let i = 1; i < kept.length; i++) pitches.push(kept[i - 1].y - kept[i].y);
  const threshold =
    pitches.length >= 3
      ? Math.max(1.4 * median(pitches), 1.2 * median(kept.map((l) => l.size)))
      : 1.2 * median(kept.map((l) => l.size));
  const textLines = [];
  for (let i = 0; i < kept.length; i++) {
    if (i > 0 && /-\s*$/.test(textLines[textLines.length - 1]) && /^[a-z]/.test(kept[i].text)) {
      // Hyphenation repair: join the split word.
      textLines[textLines.length - 1] = textLines[textLines.length - 1].replace(/-\s*$/, "") + kept[i].text;
    } else if (i > 0) {
      const isSection = sectionTitles.has(norm(kept[i].text));
      textLines.push(
        isSection || kept[i - 1].y - kept[i].y > threshold ? "\n\n" + kept[i].text : "\n" + kept[i].text
      );
    } else {
      textLines.push(kept[i].text);
    }
  }
  return textLines.join("");
}

/** Extract per-page text from a PDF. Returns an array of page strings. */
export async function extractPdfPages(pdfPath) {
  const buf = await fs.readFile(pdfPath);
  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  try {
    const sectionTitles = collectOutlineTitles(doc);
    const pageData = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const items = tc.items
        .filter((it) => it.str !== undefined && it.str !== null)
        .map((it) => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          size: Math.max(Math.abs(it.transform[3]), Math.abs(it.transform[0])) || 8,
          w: it.width ?? 0,
        }));
      const merged = mergeVerticalRuns(items);
      if (!merged.length) {
        pageData.push({ lines: [], linesByBand: [], pageHeight: 1 });
        continue;
      }
      // Real page height from the page box (falls back to the Y extent):
      // used for body-region filtering and boilerplate positions.
      const ys = merged.map((i) => i.y);
      const pageHeight =
        (page.view && page.view[3] - page.view[1]) ||
        (Math.max(...ys) - Math.min(...ys)) ||
        1;
      const columns = detectColumns(merged, pageHeight);
      let linesByBand;
      if (!columns) {
        linesByBand = [groupLines(merged)];
      } else {
        // Every item's left edge belongs to exactly one column, so no
        // character is ever dropped (two-page spreads included).
        const byCol = columns.columns.map(() => []);
        for (const item of merged) {
          const idx = columns.columns.findIndex((c) => item.x >= c.min && item.x <= c.max);
          byCol[idx === -1 ? columns.columns.length - 1 : idx].push(item);
        }
        linesByBand = byCol.map((items) => groupLines(items));
      }
      pageData.push({ lines: linesByBand.flat(), pageHeight, linesByBand });
    }
    const boilerplate = findBoilerplate(pageData);
    return pageData.map(({ linesByBand }) => {
      const parts = [];
      for (const bandLines of linesByBand) {
        const text = renderBand(bandLines, boilerplate, sectionTitles);
        if (text) parts.push(text);
      }
      return parts.join("\n\n").replace(/[ \t]+/g, " ").trim();
    });
  } finally {
    doc.destroy();
  }
}
