// Async rulebook digest for newly added games.
// 1. Extracts rulebook text and refreshes the shared search index.
// 2. Asks the LLM (local Unsloth) for a catalog description with
//    theme / lore / setting at the forefront, falling back to a rules
//    summary only when no setting or lore is available.
// 3. Persists the description into meta.json so it is reloaded, never
//    regenerated.
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { ocrPdfPages } from "./ocr-pdf.mjs";

const BASE_URL = process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";
const MODEL =
  process.env.UNSLOTH_MODEL ?? "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";

const inFlight = new Set();

/** Merge this game's pages into the shared search index. */
function rebuildIndexFor(slug, title, pages) {
  const outPath = path.join(process.cwd(), "public", "search-index.json");
  let index = { entries: [] };
  if (fs.existsSync(outPath)) {
    try {
      index = JSON.parse(fs.readFileSync(outPath, "utf8"));
    } catch {
      /* start fresh */
    }
  }
  const entries = (index.entries ?? []).filter((e) => e.slug !== slug);
  pages.forEach((text, i) => {
    const clean = (text ?? "").replace(/\s+/g, " ").trim();
    if (clean) {
      entries.push({ id: `${slug}-p${i + 1}`, slug, title, page: i + 1, text: clean, isExpansion: false });
    }
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2)
  );
}


/** Build the LLM context: opening pages (overview/lore) plus lore-looking chunks. */
function buildContext(pages) {
  const head = pages
    .slice(0, 4)
    .map((t, i) => `--- Page ${i + 1} ---\n${(t ?? "").replace(/\s+/g, " ").trim()}`)
    .join("\n\n");

  const loreWords = ["story", "setting", "welcome", "you are", "introduction", "facility", "ship", "planet"];
  const scored = pages
    .map((text, i) => {
      const lower = (text ?? "").toLowerCase();
      let score = 0;
      for (const w of loreWords) if (lower.includes(w)) score++;
      return { page: i + 1, text, score };
    })
    .filter((c) => c.score > 0 && c.page > 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const extra = scored
    .map((c) => `--- Page ${c.page} ---\n${c.text.replace(/\s+/g, " ").trim()}`)
    .join("\n\n");

  return (head + "\n\n" + extra).slice(0, 9000);
}

/**
 * Deterministically pull the structured stats (player count, play time, age)
 * straight from the rulebook text. The LLM only sees a limited excerpt and
 * can miss these "at a glance" lines when the early pages are large, so we
 * scan every page with targeted patterns instead. Returns null for anything
 * it can't find, so callers can fall back to the LLM's value.
 */
function extractStats(pages) {
  const all = pages.join("\n");
  const stats = { players: null, playtimeMinutes: null, ageRating: null };

  // Player count: "1-5 players", "for 4 players", "2 to 4 players".
  let m =
    all.match(/(\d+)\s*[-–]\s*(\d+)\s*players?/i) ||
    all.match(/for\s+(\d+)\s*players?/i) ||
    all.match(/(\d+)\s+to\s+(\d+)\s+players?/i);
  if (m) stats.players = m[1] === m[2] ? m[1] : `${m[1]}-${m[2]}`;

  // Play time: "60 to 90 minutes" (take the lower bound), "about 90 minutes".
  m = all.match(/(\d+)\s*to\s*(\d+)\s*minutes/i) || all.match(/\b(\d+)\s*minutes\b/i);
  if (m) stats.playtimeMinutes = Number(m[1]);

  // Age: "ages 12+", "age 12". The \b keeps it from matching "Pages 8" in a
  // table of contents.
  m = all.match(/\bages?\s*:?\s*(\d+)(\+?)/i);
  if (m) stats.ageRating = m[1] + (m[2] || "");

  return stats;
}

/**
 * Extract PDF pages in a child Node process. pdfjs cannot run inside the
 * Next.js server bundle (its worker setup fails to resolve modules there),
 * so we delegate to lib/extract-cli.mjs and parse its JSON output.
 */
function runExtractCli(pdfPath) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join("lib", "extract-cli.mjs"), pdfPath], {
      cwd: process.cwd(),
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => {
      if (code !== 0) return resolve([]);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve([]);
      }
    });
    proc.on("error", () => resolve([]));
  });
}

const REFUSAL_RE = /i'm sorry|sorry, but|no rulebook excerpts|cannot write|can't write/i;

async function callLlmRaw(key, title, context) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.4,
      // The local model is a reasoning model: it burns tokens on internal
      // reasoning before emitting the answer, so the budget must be large
      // enough to cover both.
      max_tokens: 4000,
      messages: [
        {
          role: "system",
          content:
            "You fill out catalog entries for a cozy board game website. You always answer with a single valid JSON object and nothing else.",
        },
        {
          role: "user",
          content:
            `Using ONLY the rulebook excerpts below, return ONE valid JSON object for the board game "${title}" with exactly these keys:\n` +
            '{\n' +
            '  "description": string,     // one paragraph, 90-140 words. Theme, lore and setting first (who the players are, where and when it takes place, the story). Only if no setting/lore exists, summarize the core goal and rules. Be specific to this game; do not invent details. Plain English, no headings, no surrounding quotation marks.\n' +
            '  "players": string or null,   // the player range stated in the rules, e.g. "1-4". null if not stated.\n' +
            '  "playtimeMinutes": number or null, // typical play time in minutes, e.g. 90. null if not stated.\n' +
            '  "ageRating": string or null,   // recommended age, e.g. "12+". null if not stated.\n' +
            '  "tags": array of strings       // 3-6 lowercase topic tags, e.g. ["strategy","cooperative"]. [] if none.\n' +
            '}\n' +
            "Return ONLY the JSON object — no markdown, no code fences, no commentary.",
        },
        {
          role: "user",
          content: `Rulebook excerpts:\n${context || "(no rulebook text available)"}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Provider error ${res.status}`);
  const data = await res.json();
  let raw = (data.choices?.[0]?.message?.content ?? "").trim();
  raw = raw.replace(/^["']|["']$/g, "");
  return raw;
}

/** Coerce a parsed JSON object into a normalized catalog shape. */
function normalizeCatalog(obj) {
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const players = typeof obj.players === "string" && obj.players.trim() ? obj.players.trim() : null;
  const ageRating = typeof obj.ageRating === "string" && obj.ageRating.trim() ? obj.ageRating.trim() : null;
  let playtimeMinutes = null;
  if (typeof obj.playtimeMinutes === "number" && Number.isFinite(obj.playtimeMinutes)) {
    playtimeMinutes = obj.playtimeMinutes;
  } else if (typeof obj.playtimeMinutes === "string" && obj.playtimeMinutes.trim()) {
    const n = Number(obj.playtimeMinutes);
    if (Number.isFinite(n)) playtimeMinutes = n;
  }
  const tags = Array.isArray(obj.tags)
    ? obj.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
    : [];
  return { description, players, playtimeMinutes, ageRating, tags };
}

/** Parse the LLM's raw output into a catalog object; null if not valid JSON. */
function parseCatalogJson(raw) {
  let text = (raw ?? "").trim();
  // Strip markdown code fences if the model added them anyway.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return normalizeCatalog(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

/**
 * Generate the full catalog entry (description + metadata) from the LLM,
 * retrying on empty / refusal responses. Reasoning models occasionally emit
 * an empty answer (all tokens spent on internal reasoning), so one bad
 * response should not sink the whole digest. If the model returns plain text
 * instead of JSON, we fall back to using it as the description only.
 */
async function generateCatalog(title, context) {
  const key = process.env.UNSLOTH_API_KEY;
  if (!key) throw new Error("UNSLOTH_API_KEY is not set");

  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await callLlmRaw(key, title, context);
    if (!raw || REFUSAL_RE.test(raw)) {
      console.log(`digest: LLM attempt ${attempt} returned empty/refusal, retrying`);
      continue;
    }
    const parsed = parseCatalogJson(raw);
    if (parsed && parsed.description) return parsed;
    // Not valid catalog JSON — fall back to description-only so we still
    // get a usable description.
    console.log(`digest: LLM attempt ${attempt} not valid catalog JSON, using description only`);
    return { description: raw, players: null, playtimeMinutes: null, ageRating: null, tags: [] };
  }
  return null;
}

/**
 * Digest a newly added game. Safe to call concurrently: no-ops if the
 * description already exists or a digest is already running.
 */
export async function digestRulebook(slug) {
  const metaPath = path.join(process.cwd(), "content", "games", slug, "meta.json");
  if (!fs.existsSync(metaPath)) return;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (meta.description || inFlight.has(slug)) return;
  inFlight.add(slug);

  try {
    const pdfPath = path.join(process.cwd(), "content", "games", slug, meta.pdf ?? "rules.pdf");
    let pages = [];
    if (fs.existsSync(pdfPath)) {
      pages = await runExtractCli(pdfPath);
      // If the PDF has no text layer (scanned / image-only), fall back to
      // OCR so we can still build a description from the actual rules.
      const hasTextLayer = pages.some((p) => (p ?? "").trim().length > 0);
      if (!hasTextLayer) {
        console.log(`digest ${slug}: no text layer — falling back to OCR`);
        try {
          pages = await ocrPdfPages(pdfPath, { maxPages: 12 });
        } catch (e) {
          console.error(`digest ${slug}: OCR failed:`, e instanceof Error ? e.message : e);
          pages = [];
        }
      }
    }

    rebuildIndexFor(slug, meta.title ?? slug, pages);

    // Only ask the LLM when we actually have rulebook text; otherwise a
    // refusal would get persisted as the description.
    const hasText = pages.some((p) => (p ?? "").trim().length > 0);
    if (!hasText) {
      console.log(`digest ${slug}: no extractable text (even via OCR), skipping LLM`);
      return;
    }

    const catalog = await generateCatalog(meta.title ?? slug, buildContext(pages));
    // Never persist a refusal / empty answer.
    if (!catalog || !catalog.description) {
      console.log(`digest ${slug}: LLM returned no description, not persisting`);
      return;
    }
    meta.description = catalog.description;

    // Fill in only the metadata fields the user left empty. For any field
    // the user DID fill in that conflicts with the rulebook, record a
    // suggestion — the player decides on the game page whether to accept it.
    // The rulebook value for each stat prefers the deterministic extraction
    // (which scans every page) over the LLM's excerpt-based guess, which can
    // miss these lines when the early pages are large.
    const stats = extractStats(pages);
    const rbPlayers = stats.players ?? catalog.players;
    const rbPlaytime = stats.playtimeMinutes ?? catalog.playtimeMinutes;
    const rbAge = stats.ageRating ?? catalog.ageRating;

    const suggestions = [];
    const norm = (v) => String(v ?? "").trim().toLowerCase();

    if (meta.players && rbPlayers) {
      if (norm(meta.players) !== norm(rbPlayers)) {
        suggestions.push({
          field: "players",
          current: meta.players,
          suggested: rbPlayers,
          note: `The rulebook says ${rbPlayers} players.`,
        });
      }
    } else if (!meta.players && rbPlayers) {
      meta.players = rbPlayers;
    }

    if (meta.playtimeMinutes && rbPlaytime) {
      if (Number(meta.playtimeMinutes) !== Number(rbPlaytime)) {
        suggestions.push({
          field: "playtimeMinutes",
          current: meta.playtimeMinutes,
          suggested: rbPlaytime,
          note: `The rulebook suggests about ${rbPlaytime} minutes.`,
        });
      }
    } else if (!meta.playtimeMinutes && rbPlaytime) {
      meta.playtimeMinutes = rbPlaytime;
    }

    if (meta.ageRating && rbAge) {
      if (norm(meta.ageRating) !== norm(rbAge)) {
        suggestions.push({
          field: "ageRating",
          current: meta.ageRating,
          suggested: rbAge,
          note: `The rulebook suggests ${rbAge}.`,
        });
      }
    } else if (!meta.ageRating && rbAge) {
      meta.ageRating = rbAge;
    }

    if ((!meta.tags || meta.tags.length === 0) && catalog.tags.length > 0) {
      meta.tags = catalog.tags;
    }

    meta.suggestions = suggestions;

    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(
      `digest ${slug}: description + metadata written (${catalog.description.length} chars)`
    );
  } finally {
    inFlight.delete(slug);
  }
}
