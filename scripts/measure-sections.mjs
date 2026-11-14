// Measures the "Other" bucket percentage in the search index (issue #71).
// Usage: node scripts/measure-sections.mjs [path-to-index]
//
// Compares the current index against the target: < 15% "Other".
// Before the section index (v1), the "Other" bucket was ~42%.
import fs from "fs/promises";
import path from "path";

const indexPath = process.argv[2] ?? path.join(process.cwd(), "public", "search-index.json");

let data;
try {
  data = JSON.parse(await fs.readFile(indexPath, "utf8"));
} catch (e) {
  console.error(`Cannot read index: ${e.message}`);
  process.exit(1);
}

const entries = data.entries ?? [];
if (entries.length === 0) {
  console.log("Index has no entries — nothing to measure.");
  process.exit(0);
}

// Count "Other" pages: sectionPath is "other", "unknown", empty, or missing.
let otherCount = 0;
for (const e of entries) {
  const sp = e.sectionPath;
  if (!sp || sp === "other" || sp === "unknown") otherCount++;
}

const total = entries.length;
const pct = ((otherCount / total) * 100).toFixed(1);

console.log(`Index: ${indexPath}`);
console.log(`Schema version: ${data.schemaVersion ?? "v1 (no field)"}`);
console.log(`Total pages: ${total}`);
console.log(`"Other" pages: ${otherCount} (${pct}%)`);
console.log(`Target: < 15%`);
const pass = otherCount / total < 0.15;
console.log(pass ? "✓ PASS" : "✗ FAIL");
// Exit non-zero on failure so CI can gate on the < 15% target.
if (!pass) process.exit(1);
