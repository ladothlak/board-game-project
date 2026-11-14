// Measures extraction quality over all local rulebook PDFs (issue #70).
// Run BEFORE and AFTER the layout-aware extractor to compare:
//   node scripts/measure-extraction.mjs > /tmp/before.txt
//   node scripts/measure-extraction.mjs > /tmp/after.txt
// It imports lib/extract-pdf.mjs, so it measures whatever implementation
// is in place — no flag needed.
import fs from "fs/promises";
import path from "path";
import { extractPdfPages } from "../lib/extract-pdf.mjs";

const root = process.cwd();
const gamesDir = path.join(root, "content", "games");

async function listPdfs(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listPdfs(p)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) out.push(p);
  }
  return out;
}

/** True when a page's leading text is furniture: page number, print-shop
 * boilerplate, running heads ("flat sheet"), or InDesign job names (.indd). */
function startsWithBoilerplate(pageText) {
  const firstLine = (pageText.split(/\n+/)[0] ?? "").trim();
  if (!firstLine) return true; // empty page counts as boilerplate-free? no — count it.
  return (
    /^\d+$/.test(firstLine) ||
    /^printed by/i.test(firstLine) ||
    /flat sheet/i.test(firstLine) ||
    /\.indd\b/i.test(firstLine)
  );
}

/** True when a page starts mid-word: first character is lowercase, so the
 * text begins inside a sentence (e.g. a column wrap that dropped the start). */
function startsMidWord(pageText) {
  const t = pageText.trim();
  if (!t) return false;
  return /^[a-z]/.test(t);
}

const pdfs = await listPdfs(gamesDir);
let totalBoilerplate = 0;
let totalMidWord = 0;
let totalPages = 0;
for (const pdf of pdfs) {
  const rel = path.relative(root, pdf);
  let pages;
  try {
    pages = await extractPdfPages(pdf);
  } catch (e) {
    console.log(`${rel}: FAILED — ${e.message}`);
    continue;
  }
  let boilerplate = 0;
  let midWord = 0;
  for (const text of pages) {
    if (startsWithBoilerplate(text)) boilerplate++;
    if (startsMidWord(text)) midWord++;
  }
  totalBoilerplate += boilerplate;
  totalMidWord += midWord;
  totalPages += pages.length;
  console.log(
    `${rel}: ${pages.length} pages, ${boilerplate} boilerplate-start, ${midWord} mid-word-start`
  );
}
console.log("");
console.log(`TOTAL: ${totalPages} pages across ${pdfs.length} PDFs`);
console.log(`Boilerplate-start pages: ${totalBoilerplate}`);
console.log(`Mid-word-start pages: ${totalMidWord}`);
