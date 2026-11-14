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
 *
 * Known limitation: three-column layouts (e.g. Betrayal p12) are not fully
 * resolved — the structural gutter checks can't separate all three columns
 * without misfiring on aligned multi-column baselines. A full multi-column
 * algorithm is a follow-up; until then those pages keep some fused text.
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
  const minGapSmall = Math.max(2, pageWidth * 0.005);
  // Per-slice candidates, keeping each slice's items so the structural metrics
  // below can be computed per voting slice.
  const perSliceCands = [];
  for (let s = 0; s < nSlices; s++) {
    const sItems = slices[s];
    const intervals = sItems
      .map((it) => [it.x, it.x + it.w])
      .sort((p, q) => p[0] - q[0]);
    const cands = [];
    for (let i = 1; i < intervals.length; i++) {
      const a = intervals[i - 1][1];
      const b = intervals[i][0];
      if (b - a >= minGapSmall) cands.push({ a, b });
    }
    perSliceCands.push(cands);
  }
  // Cluster candidates by the RIGHT edge b (start of ink in the right
  // column), which is stable across slices even when the left column's edge
  // is ragged: each line ends at a different X, so the gap center drifts
  // slice-to-slice and a center-based cluster never reaches needVotes. The
  // same physical gutter's b values sit within mergeDist of each other,
  // while distinct gutters are a column width apart.
  const mergeDist = Math.max(10, pageWidth * 0.1);
  const clusters = [];
  for (let s = 0; s < nSlices; s++) {
    for (const c of perSliceCands[s]) {
      const cl = clusters.find((cl) => Math.abs(cl.bAnchor - c.b) <= mergeDist);
      if (!cl)
        clusters.push({ bAnchor: c.b, votes: new Set([s]), a: c.a, b: c.b, perSlice: { [s]: c } });
      else {
        cl.votes.add(s);
        cl.a = Math.min(cl.a, c.a);
        cl.b = Math.max(cl.b, c.b);
        cl.perSlice[s] = c;
      }
    }
  }
  // A real column gutter splits the body region into two independent columns,
  // so it must have SUBSTANTIAL INK ON BOTH SIDES and almost no text flowing
  // across it. Those properties — not the gutter's absolute position — are
  // the signal:
  //  - Left ink: a spurious "gutter" at a column's LEFT MARGIN (the gap
  //    between the page edge and the first column) has almost no ink to its
  //    left and is rejected; a real gutter has a full column on the left.
  //  - Right coherence: a far-right inter-word gap on a single-column page is
  //    crossed by most lines (ink on both sides in most slices), so it is
  //    rejected; a real gutter separates two columns, so only a couple of
  //    full-width elements (headings, dotted leaders) cross it.
  // The vote floor is deliberately low: a short sidebar spans only a few
  // slices, so a real gutter can legitimately earn few votes. The structural
  // checks above do the discriminating work a position threshold used to do,
  // which is what let asymmetric two-column pages (wide left column, narrow
  // right sidebar) keep their gutters without admitting far-right inter-word
  // gaps on single-column pages.
  const needVotes = Math.max(4, Math.ceil(nSlices * 0.5));
  const guttersFinal = [];
  for (const cl of clusters) {
    if (cl.votes.size < needVotes) continue;
    let leftOk = 0;
    let rightOk = 0;
    for (const s of cl.votes) {
      const c = cl.perSlice[s];
      const sItems = slices[s];
      const totalW = sItems.reduce((t, i) => t + i.w, 0);
      // Left ink: width of items lying entirely to the left of b.
      const leftW = sItems.reduce(
        (t, i) => t + (i.x + i.w < c.b - 1 ? i.w : 0),
        0,
      );
      if (totalW > 0 && leftW / totalW >= 0.2) leftOk++;
      // Right coherence: group the slice's items into lines by Y; a line
      // "crosses" b when it has ink on both sides of it.
      const byY = [...sItems].sort((p, q) => p.y - q.y);
      const lines = [];
      for (const it of byY) {
        const l = lines[lines.length - 1];
        if (l && Math.abs(it.y - l.y) < 6) l.items.push(it);
        else lines.push({ y: it.y, items: [it] });
      }
      let crossLines = 0;
      for (const l of lines) {
        const hasLeft = l.items.some((i) => i.x + i.w < c.b - 1);
        const hasRight = l.items.some((i) => i.x > c.b + 1);
        if (hasLeft && hasRight) crossLines++;
      }
      if (crossLines <= 2) rightOk++;
    }
    const leftFrac = leftOk / cl.votes.size;
    const rightFrac = rightOk / cl.votes.size;
    if (leftFrac >= 0.5 && rightFrac >= 0.55) guttersFinal.push(cl);
  }
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
  // Drop caps are ~2–3× body size; flag them so they are placed by baseline
  // instead of top edge (their baseline sits at the bottom of the multi-line
  // span they occupy, so Y-joining plants them mid-page).
  const medianSize = median(items.map((i) => i.size));
  const oversizeThreshold = 2 * medianSize;
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const lines = [];
  let line = null;
  for (const item of sorted) {
    // Space items are kept: they carry the word separators between text runs.
    if (item.size > oversizeThreshold) {
      // Place oversized items (drop caps) by their BASELINE, which sits at the
      // BOTTOM of the multi-line span they occupy. The cap belongs to the
      // topmost line of that span, so join it to the highest existing line
      // whose baseline falls within [item.y, item.y + item.size] (the em
      // bounds the span from below). Estimating the visual top from the em
      // (baseline + 0.75·em) fails because the em is ~1.5–3× the true span, so
      // it over- or under-shoots the first line's top depending on the cap;
      // anchoring on the baseline instead is stable for every cap.
      const allLines = line ? [...lines, line] : lines;
      let best = null;
      for (const l of allLines) {
        if (l.topY >= item.y && l.topY <= item.y + item.size) {
          if (!best || l.topY > best.topY) best = l;
        }
      }
      if (line && line !== best) {
        lines.push(line);
        line = null;
      }
      if (best) best.items.push(item);
      else line = { topY: item.y, items: [item] };
    } else {
      // Tolerance scaled to the incoming item's size. Oversized items (drop
      // caps) are handled in the branch above by top edge, so they never reach
      // this path; a large drop cap therefore cannot inflate the tolerance and
      // join the line above its baseline.
      const tol = Math.max(2, 0.45 * item.size);
      if (line && item.y >= line.topY - tol) {
        line.items.push(item);
      } else {
        if (line) lines.push(line);
        line = { topY: item.y, items: [item] };
      }
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
      width: l.items.reduce((t, i) => t + (i.w || 0), 0),
      charCount: text.replace(/\s/g, "").length,
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

// Print-shop furniture: InDesign job names (e.g. "newrules3.qxd:CarcRegelNeu4_2+bbUS")
// sit in the page header and are not rulebook content. They are dropped by pattern
// rather than by the document-wide boilerplate pass, because their text varies per
// page (a date/time/page stamp is appended) and column detection can split the line
// across bands, so the normalized text is never consistent enough to be caught there.
const INDESIGN_FURNITURE = /\.(qxd|indd|indt):/i;

function renderBand(lines, boilerplate, sectionTitles) {
  const kept = lines.filter(
    (l) => l.text && !boilerplate.has(norm(l.text)) && !INDESIGN_FURNITURE.test(l.text),
  );
  if (!kept.length) return "";
  const pitches = [];
  for (let i = 1; i < kept.length; i++) pitches.push(kept[i - 1].y - kept[i].y);
  const threshold =
    pitches.length >= 3
      ? Math.max(1.4 * median(pitches), 1.3 * median(kept.map((l) => l.size)))
      : 1.3 * median(kept.map((l) => l.size));
  const textLines = [];
  for (let i = 0; i < kept.length; i++) {
    if (
      i > 0 &&
      /-\s*$/.test(textLines[textLines.length - 1]) &&
      /^[a-z]/.test(kept[i].text) &&
      kept[i - 1].y - kept[i].y <= threshold
    ) {
      // Hyphenation repair: join the split word. Only when the Y gap is a
      // normal line pitch — a paragraph break must not be fused.
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

/**
 * Compute the body median font size across all lines in the document.
 * Used as the baseline for heading detection.
 */
function computeBodyMedian(pageData) {
  const sizes = [];
  for (const { lines } of pageData) {
    for (const l of lines) {
      if (l.text && l.charCount >= 3) sizes.push(l.size);
    }
  }
  return median(sizes) || 10;
}

/**
 * Detect bold lines via a glyph-width heuristic. pdfjs v4 does not expose
 * font weight through its public API, but bold fonts have wider glyphs per
 * em than regular fonts at the same size. We compute perEm = width /
 * (charCount * size) for each line, group by size bucket, and flag lines
 * whose perEm is clearly above the minimum in their bucket as bold.
 */
function detectBoldFlags(pageData) {
  // Collect all non-empty lines with their perEm.
  const allLines = [];
  for (const [pi, { lines }] of pageData.entries()) {
    for (const [li, l] of lines.entries()) {
      if (!l.text || l.charCount < 3) continue;
      const perEm = l.width / (l.charCount * l.size);
      allLines.push({ pi, li, perEm, size: l.size });
    }
  }
  // Group by size bucket (rounded to 0.5pt).
  const buckets = new Map();
  for (const entry of allLines) {
    const key = Math.round(entry.size * 2) / 2;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  // Flag bold: within a bucket, if max perEm >= 1.10 * min perEm AND the bucket
  // has enough lines (>= 5) for the spread to be meaningful (fewer lines →
  // character-composition noise dominates), lines with perEm above the median
  // are bold.
  const boldSet = new Set();
  for (const entries of buckets.values()) {
    if (entries.length < 5) continue;
    const perEmS = entries.map((e) => e.perEm).sort((a, b) => a - b);
    const minP = perEmS[0];
    const maxP = perEmS[perEmS.length - 1];
    if (maxP < minP * 1.10) continue; // no significant spread → no bold
    const medP = perEmS[Math.floor(perEmS.length / 2)];
    for (const e of entries) {
      if (e.perEm > medP) boldSet.add(`${e.pi}:${e.li}`);
    }
  }
  return boldSet;
}

/**
 * Find heading candidates on a single page's lines.
 * A line is a heading when:
 *   - its size >= 1.3 * bodyMedian, OR it is bold AND size >= 0.95 * bodyMedian
 *   - it sits at a new-block position (preceded by a blank gap or at page top)
 *   - its text has >= 2 letters and <= 80 chars
 */
function findHeadings(lines, bodyMedian, boldSet, pageIndex) {
  if (!lines.length) return [];
  const headings = [];
  // Compute median pitch (consecutive Y gaps) for the blank-gap threshold.
  const pitches = [];
  for (let i = 1; i < lines.length; i++) {
    pitches.push(lines[i - 1].y - lines[i].y);
  }
  const gapThreshold = pitches.length >= 3
    ? Math.max(1.4 * median(pitches), 1.3 * bodyMedian)
    : 1.3 * bodyMedian;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.text || l.charCount < 2 || l.text.length > 80) continue;
    // Letter count check: at least 2 alphabetic characters.
    const letters = (l.text.match(/[a-zA-Z]/g) || []).length;
    if (letters < 2) continue;

    const isOversize = l.size >= 1.3 * bodyMedian;
    const isBold = boldSet.has(`${pageIndex}:${i}`);
    const isBoldSizeOk = isBold && l.size >= 0.95 * bodyMedian;
    if (!isOversize && !isBoldSizeOk) continue;

    // New-block check: first line on the page, or preceded by a blank gap.
    let isNewBlock = false;
    if (i === 0) {
      isNewBlock = true;
    } else {
      const gap = lines[i - 1].y - l.y;
      isNewBlock = gap > gapThreshold;
    }
    if (!isNewBlock) continue;

    headings.push({ text: l.text, y: l.y, size: l.size, bold: isBold });
  }
  return headings;
}

/**
 * Extract per-page text AND heading information from a PDF.
 * Returns an array of `{ text: string; headings: HeadingInfo[] }` per page.
 *
 * HeadingInfo: { text, y, size, bold }
 *
 * This is the new API for issue #71 (section index). The legacy
 * `extractPdfPages` remains available and returns plain strings.
 */
export async function extractPdfPagesWithHeadings(pdfPath) {
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
      const ys = merged.map((i) => i.y);
      const pageHeight =
        (page.view ? Math.abs(page.view[3] - page.view[1]) : 0) ||
        (Math.max(...ys) - Math.min(...ys)) ||
        1;
      const columns = detectColumns(merged, pageHeight);
      let linesByBand;
      if (!columns) {
        linesByBand = [groupLines(merged)];
      } else {
        const byCol = columns.columns.map(() => []);
        for (const item of merged) {
          let idx = columns.columns.findIndex((c) => item.x >= c.min && item.x <= c.max);
          if (idx === -1) {
            let best = 0;
            let bestDist = Infinity;
            for (let ci = 0; ci < columns.columns.length; ci++) {
              const c = columns.columns[ci];
              const d = item.x < c.min ? c.min - item.x : item.x - c.max;
              if (d < bestDist) {
                bestDist = d;
                best = ci;
              }
            }
            idx = best;
          }
          byCol[idx].push(item);
        }
        linesByBand = byCol.map((items) => groupLines(items));
      }
      pageData.push({ lines: linesByBand.flat(), pageHeight, linesByBand });
    }
    const boilerplate = findBoilerplate(pageData);
    const bodyMedian = computeBodyMedian(pageData);
    const boldSet = detectBoldFlags(pageData);

    return pageData.map(({ linesByBand, lines }, pi) => {
      const parts = [];
      for (const bandLines of linesByBand) {
        const text = renderBand(bandLines, boilerplate, sectionTitles);
        if (text) parts.push(text);
      }
      const text = parts.join("\n\n").replace(/[ \t]+/g, " ").trim();
      const headings = findHeadings(lines, bodyMedian, boldSet, pi);
      return { text, headings };
    });
  } finally {
    doc.destroy();
  }
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
        (page.view ? Math.abs(page.view[3] - page.view[1]) : 0) ||
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
          let idx = columns.columns.findIndex((c) => item.x >= c.min && item.x <= c.max);
          if (idx === -1) {
            // X matches no column span: assign to the NEAREST column edge
            // rather than always the last column, so items just outside a
            // span land in the adjacent band.
            let best = 0;
            let bestDist = Infinity;
            for (let ci = 0; ci < columns.columns.length; ci++) {
              const c = columns.columns[ci];
              const d = item.x < c.min ? c.min - item.x : item.x - c.max;
              if (d < bestDist) {
                bestDist = d;
                best = ci;
              }
            }
            idx = best;
          }
          byCol[idx].push(item);
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
