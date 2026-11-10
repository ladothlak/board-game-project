#!/usr/bin/env node
// Back up the irreplaceable parts of the parlor — every game's files plus
// the search index — into a timestamped tarball under backups/. This is the
// safety net for "delete everything" and hardware loss: run it regularly.

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const backupDir = path.join(root, "backups");
const KEEP = 10; // number of most-recent archives to retain

const targets = [
  path.join(root, "content", "games"),
  path.join(root, "public", "search-index.json"),
];

// Only back up what actually exists.
const present = [];
for (const t of targets) {
  try {
    await fs.access(t);
    present.push(t);
  } catch {
    /* target missing */
  }
}
if (present.length === 0) {
  console.error("Nothing to back up (no content/games/ or search index found).");
  process.exit(1);
}

await fs.mkdir(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const archiveName = `parlor-${stamp}.tar.gz`;
const archivePath = path.join(backupDir, archiveName);

// tar -czf <archive> -C <root> <relative paths>
const relTargets = present.map((t) => path.relative(root, t));
execFileSync("tar", ["-czf", archivePath, "-C", root, ...relTargets], { stdio: "inherit" });

console.log(`Wrote ${archiveName}`);

// Prune old archives beyond KEEP.
const existing = (await fs.readdir(backupDir))
  .filter((f) => f.startsWith("parlor-") && f.endsWith(".tar.gz"))
  .sort()
  .reverse(); // newest first (timestamp in name sorts chronologically)

for (const old of existing.slice(KEEP)) {
  const p = path.join(backupDir, old);
  try {
    await fs.rm(p);
  } catch {
    /* already gone */
  }
  console.log(`Pruned ${old}`);
}
