/**
 * Second pass: add 4 more games to reach 20 total new additions.
 * Run: node scripts/add-via-intellisearch.mjs [batch-2]
 */

const BASE = "http://localhost:3111";
const TARGET = 4;

const CANDIDATES = [
  "Oasis",
  "Patchwork",
  "Sagrada",
  "Ticket to Ride Europe",
  "7 Wonders",
  "Stone Age",
  "Twilight Struggle",
  "Mage Knight",
  "Nemesis",
  "Lords of Waterdeep",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookup(name) {
  const res = await fetch(`${BASE}/api/games/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchRulebook(gameName, publisherName) {
  const res = await fetch(`${BASE}/api/games/fetch-rulebook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameName, publisherName }),
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return { pdf: buf, url: res.headers.get("X-Pdf-Url"), foundVia: res.headers.get("X-Found-Via") };
}

async function addGame({ title, pdf, players, tags, playtimeMinutes, ageRating }) {
  const form = new FormData();
  form.append("title", title);
  form.append("pdf", new Blob([pdf], { type: "application/pdf" }), "rules.pdf");
  if (players) form.append("players", players);
  if (tags) form.append("tags", tags.join(","));
  if (playtimeMinutes) form.append("playtimeMinutes", String(playtimeMinutes));
  if (ageRating) form.append("ageRating", ageRating);

  const res = await fetch(`${BASE}/api/games`, { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function main() {
  let added = 0;
  const results = [];

  for (const name of CANDIDATES) {
    if (added >= TARGET) break;

    process.stdout.write(`\n[${added + 1}/${TARGET}] ${name}\n`);

    let meta = null;
    try {
      meta = await lookup(name);
    } catch (e) {
      console.log(`  lookup error: ${e.message}`);
    }
    if (!meta) {
      console.log(`  ✗ no metadata found — skipping`);
      results.push({ name, status: "no-metadata" });
      await sleep(13_000);
      continue;
    }

    console.log(`  ✓ metadata: ${meta.title} (${meta.players ?? "?"} players)`);
    await sleep(13_000);

    let pdfData = null;
    try {
      pdfData = await fetchRulebook(name, meta.publisherName ?? undefined);
    } catch (e) {
      console.log(`  fetch error: ${e.message}`);
    }
    if (!pdfData) {
      console.log(`  ✗ no rulebook PDF found — skipping`);
      results.push({ name, status: "no-rulebook" });
      await sleep(13_000);
      continue;
    }

    console.log(`  ✓ rulebook: ${pdfData.url} (${(pdfData.pdf.length / 1024).toFixed(0)} KB, via ${pdfData.foundVia})`);
    await sleep(13_000);

    try {
      const result = await addGame({
        title: meta.title,
        pdf: pdfData.pdf,
        players: meta.players,
        tags: meta.tags,
        playtimeMinutes: meta.playtimeMinutes,
        ageRating: meta.ageRating,
      });
      console.log(`  ✓ added: ${result.slug}`);
      results.push({ name, status: "added", slug: result.slug });
      added++;
    } catch (e) {
      console.log(`  ✗ add failed: ${e.message}`);
      results.push({ name, status: "add-failed", error: e.message });
    }
  }

  console.log(`\n\n=== Summary ===`);
  console.log(`Added: ${added}/${TARGET}`);
  for (const r of results) {
    const mark = r.status === "added" ? "✓" : "✗";
    console.log(`  ${mark} ${r.name}: ${r.status}${r.slug ? ` → ${r.slug}` : ""}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
