/**
 * Add games to the shelf using the website's intellisearch API endpoints.
 * For each candidate game: lookup metadata → fetch rulebook PDF → add game.
 * Skips games where no rulebook can be found. Stops after 20 successes.
 *
 * Run: node scripts/add-via-intellisearch.mjs
 */

const BASE = "http://localhost:3111";
const TARGET = 20;

// 30 candidate games (well-known titles likely to have public rulebooks).
const CANDIDATES = [
  "7 Wonders",
  "Ticket to Ride",
  "Pandemic",
  "Splendor",
  "Wingspan",
  "Terraforming Mars",
  "Scythe",
  "Azul",
  "Carcassonne",
  "Dominion",
  "Gloomhaven",
  "Flash Point",
  "Hanamikoji",
  "Munchkin",
  "Race for the Galaxy",
  "Stone Age",
  "Twilight Struggle",
  "Viticulture",
  "Cascadia",
  "Clank",
  "Everdell",
  "Frosthaven",
  "Kingdomino",
  "Lords of Waterdeep",
  "Mage Knight",
  "Nemesis",
  "Oasis",
  "Patchwork",
  "Root", // already on shelf — will be skipped by slug check
  "Sagrada",
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

    // Step 1: Lookup metadata.
    let meta = null;
    try {
      meta = await lookup(name);
    } catch (e) {
      console.log(`  lookup error: ${e.message}`);
    }
    if (!meta) {
      console.log(`  ✗ no metadata found — skipping`);
      results.push({ name, status: "no-metadata" });
      await sleep(13_000); // rate limit cooldown
      continue;
    }

    console.log(`  ✓ metadata: ${meta.title} (${meta.players ?? "?"} players)`);
    await sleep(13_000); // rate limit cooldown for lookup

    // Step 2: Fetch rulebook PDF.
    let pdfData = null;
    try {
      pdfData = await fetchRulebook(name, meta.publisherName ?? undefined);
    } catch (e) {
      console.log(`  fetch error: ${e.message}`);
    }
    if (!pdfData) {
      console.log(`  ✗ no rulebook PDF found — skipping`);
      results.push({ name, status: "no-rulebook" });
      await sleep(13_000); // rate limit cooldown for fetch
      continue;
    }

    console.log(`  ✓ rulebook: ${pdfData.url} (${(pdfData.pdf.length / 1024).toFixed(0)} KB, via ${pdfData.foundVia})`);
    await sleep(13_000); // rate limit cooldown for fetch

    // Step 3: Add the game.
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
    console.log(`  ${mark} ${r.name}: ${r.status}${r.slug ? ` → ${r.slug}` : ""}${r.error ? ` (${r.error})` : ""}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
