// Shared section logic used by both scripts/build-index.mjs (index build) and
// lib/rag.ts (runtime retrieval). Keeping the patterns and assignment in one
// place guarantees the index and the retriever agree on section names.

export const SECTION_PATTERNS = [
  { name: "setup", re: /set\s?up|starting?\s+the\s+(game|match)/i },
  { name: "rules", re: /\brules?\b/i },
  { name: "scoring", re: /scor(e|ing)|points|winning?/i },
  { name: "turn", re: /turn|round|phase|player\s+turn/i },
  { name: "components", re: /component|contents|what'?s\s+in|box\s+contents/i },
  { name: "victory", re: /win(ning)?\b|victory|game\s+end/i },
  { name: "reference", re: /reference|cheat\s*sheet|quick\s*(start|reference)/i },
  { name: "example", re: /example|sample/i },
];

/**
 * Fallback section matcher: scan the first ~200 characters of text for a
 * known section keyword. Used when a page has no structural heading.
 */
export function regexSectionForText(text) {
  const head = (text || "").slice(0, 200);
  for (const p of SECTION_PATTERNS) {
    if (p.re.test(head)) return p.name;
  }
  return "other";
}

/**
 * Assign a sectionPath to each page.
 *
 * Pages with structural headings get a path built from the heading stack:
 * push each heading, popping any existing entries whose size is <= the new
 * heading's size (a larger/equal heading closes all smaller sections). The
 * PRIMARY section is the LAST heading in reading order — content at the end
 * of a page belongs to the most recently opened section.
 *
 * Pages with no detectable heading fall back to regex matching on their text.
 *
 * @param {Array<{ text: string, headings: Array<{ text: string, size: number }> }>} pages
 * @returns {string[]} one sectionPath per page
 */
export function assignSectionPaths(pages) {
  const paths = [];
  const stack = []; // { text, size }

  for (const p of pages) {
    let hasHeading = false;
    for (const h of p.headings || []) {
      while (stack.length && stack[stack.length - 1].size <= h.size) {
        stack.pop();
      }
      stack.push({ text: h.text, size: h.size });
      hasHeading = true;
    }
    if (hasHeading) {
      paths.push(stack.map(s => s.text).join(" > "));
    } else {
      // No structural heading on this page: fall back to regex.
      paths.push(regexSectionForText(p.text));
    }
  }
  return paths;
}
