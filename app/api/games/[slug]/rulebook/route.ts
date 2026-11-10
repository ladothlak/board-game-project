import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { getGame, invalidateGamesCache } from "@/lib/games";
import { checkRate } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";

const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100 MB

/**
 * Replace a game's rulebook PDF and re-digest all LLM-generated content.
 * Accepts a multipart form with a "pdf" file field.
 *
 * Steps:
 * 1. Save the new PDF (replacing the old one).
 * 2. Re-extract text + rebuild the search index for this slug.
 * 3. Regenerate the LLM description + metadata.
 * 4. Regenerate key concepts.
 * 5. Regenerate setup checklist.
 * 6. Update complexity score.
 * 7. Invalidate in-memory caches.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const start = Date.now();
  const { slug } = await ctx.params;
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";

  // Rate limit: 3 per minute (PDF uploads are heavy).
  const rate = checkRate(ip, `/api/games/${slug}/rulebook`, 3, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: `/api/games/${slug}/rulebook`, method: "POST", status: 429, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Too many uploads — wait a minute." }, { status: 429 });
  }

  const game = getGame(slug);
  if (!game) {
    logRequest({ ip, route: `/api/games/${slug}/rulebook`, method: "POST", status: 404, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form" }, { status: 400 });
  }

  const pdf = form.get("pdf") as File | null;
  if (!pdf || pdf.size === 0) {
    return NextResponse.json({ error: "A PDF file is required" }, { status: 400 });
  }
  if (pdf.size > MAX_PDF_SIZE) {
    return NextResponse.json({ error: "PDF is too large (max 100 MB)" }, { status: 413 });
  }

  const dir = path.join(process.cwd(), "content", "games", slug);
  if (!fs.existsSync(dir)) {
    return NextResponse.json({ error: "Game directory not found" }, { status: 404 });
  }

  // Save the new PDF.
  const pdfName = game.pdf ?? "rules.pdf";
  const pdfPath = path.join(dir, pdfName);
  const bytes = Buffer.from(await pdf.arrayBuffer());

  // Sanity check: must start with %PDF.
  if (bytes.subarray(0, 4).toString() !== "%PDF") {
    return NextResponse.json({ error: "File doesn't look like a valid PDF" }, { status: 400 });
  }

  fs.writeFileSync(pdfPath, bytes);

  // Update meta.json to point to the new file (in case the filename changed).
  const metaPath = path.join(dir, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.pdf = pdfName;

  invalidateGamesCache();

  logRequest({ ip, route: `/api/games/${slug}/rulebook`, method: "POST", status: 200, durationMs: Date.now() - start });

  // Fire-and-forget: re-digest everything in the background.
  // The client polls for completion via GET on this same route.
  reDigest(slug).catch((e) => {
    console.error(`rulebook re-digest failed for ${slug}:`, e);
  });

  return NextResponse.json({
    status: "digesting",
    message: "Rulebook replaced. Content is being regenerated in the background.",
  });
}

/**
 * GET: report the digest status so the client can poll.
 * Returns { done: true } once all content has been regenerated.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const { slug } = await ctx.params;

  // Check if the digest is still in flight.
  const statusPath = path.join(process.cwd(), "content", "games", slug, ".digesting");
  if (fs.existsSync(statusPath)) {
    return NextResponse.json({ done: false });
  }

  return NextResponse.json({ done: true });
}

// ─── Re-digest logic ──────────────────────────────────────────────────────

async function reDigest(slug: string) {
  const dir = path.join(process.cwd(), "content", "games", slug);
  const metaPath = path.join(dir, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const pdfPath = path.join(dir, meta.pdf ?? "rules.pdf");

  // Mark as digesting.
  fs.writeFileSync(path.join(dir, ".digesting"), new Date().toISOString());

  try {
    // 1. Extract text from the PDF (child process).
    const pages = await extractPdf(pdfPath);

    // 2. Rebuild the search index for this slug.
    rebuildIndexFor(slug, meta.title ?? slug, pages);

    // 3. Regenerate description + metadata via LLM.
    if (pages.some((p) => (p ?? "").trim().length > 0)) {
      const catalog = await generateCatalog(meta.title ?? slug, buildContext(pages));
      if (catalog?.description) {
        meta.description = catalog.description;
        // Update metadata fields (players, playtime, age, tags).
        const stats = extractStats(pages);
        if (stats.players && !meta.players) meta.players = stats.players;
        if (stats.playtimeMinutes && !meta.playtimeMinutes) meta.playtimeMinutes = stats.playtimeMinutes;
        if (stats.ageRating && !meta.ageRating) meta.ageRating = stats.ageRating;
        if (catalog.tags.length > 0 && (!meta.tags || meta.tags.length === 0)) {
          meta.tags = catalog.tags;
        }
      }
    }

    // 4. Regenerate key concepts.
    const apiKey = process.env.UNSLOTH_API_KEY;
    if (apiKey) {
      try {
        const { generateConcepts, writeConcepts } = await import("@/lib/generate-concepts");
        const concepts = await generateConcepts(slug, apiKey);
        writeConcepts(slug, concepts);
      } catch (e) {
        console.error(`reDigest: concepts failed for ${slug}:`, e);
      }

      // 5. Regenerate setup checklist.
      try {
        const { generateChecklist, writeChecklist } = await import("@/lib/generate-checklist");
        const checklist = await generateChecklist(slug);
        if (checklist) writeChecklist(slug, checklist);
      } catch (e) {
        console.error(`reDigest: checklist failed for ${slug}:`, e);
      }

      // 6. Update complexity score.
      try {
        const BASE_URL = process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";
        const MODEL = process.env.UNSLOTH_MODEL ?? "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: MODEL,
            temperature: 0.2,
            max_tokens: 10,
            messages: [{ role: "system", content: `You are a board game expert. Estimate the complexity of this game on a scale of 1 (very simple) to 5 (very heavy). Game: ${meta.title}. Description: ${meta.description ?? ""}. Respond with ONLY a single integer from 1 to 5.` }],
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const score = Math.min(5, Math.max(1, parseInt((data.choices?.[0]?.message?.content ?? "").trim(), 10) || 3));
          meta.complexity = score;
        }
      } catch (e) {
        console.error(`reDigest: complexity failed for ${slug}:`, e);
      }
    }

    // Persist updated meta.
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    invalidateGamesCache();
  } finally {
    // Clear the digesting marker.
    const statusPath = path.join(dir, ".digesting");
    if (fs.existsSync(statusPath)) fs.unlinkSync(statusPath);
  }
}

// ─── Helper functions (duplicated from digest-rulebook.mjs for the TS route) ──

function extractPdf(pdfPath: string): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join("lib", "extract-cli.mjs"), pdfPath], {
      cwd: process.cwd(),
    });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => (out += d));
    proc.on("close", (code: number) => {
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

function rebuildIndexFor(slug: string, title: string, pages: string[]) {
  const outPath = path.join(process.cwd(), "public", "search-index.json");
  let index = { entries: [] as any[] };
  if (fs.existsSync(outPath)) {
    try {
      index = JSON.parse(fs.readFileSync(outPath, "utf8"));
    } catch {
      /* start fresh */
    }
  }
  const entries = (index.entries ?? []).filter((e: any) => e.slug !== slug);
  pages.forEach((text, i) => {
    const clean = (text ?? "").replace(/\s+/g, " ").trim();
    if (clean) {
      entries.push({ id: `${slug}-p${i + 1}`, slug, title, page: i + 1, text: clean });
    }
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2)
  );
}

function buildContext(pages: string[]): string {
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
    .map((c) => `--- Page ${c.page} ---\n${(c.text ?? "").replace(/\s+/g, " ").trim()}`)
    .join("\n\n");

  return (head + "\n\n" + extra).slice(0, 9000);
}

function extractStats(pages: string[]) {
  const all = pages.join("\n");
  const stats = { players: null as string | null, playtimeMinutes: null as number | null, ageRating: null as string | null };

  let m =
    all.match(/(\d+)\s*[-–]\s*(\d+)\s*players?/i) ||
    all.match(/for\s+(\d+)\s*players?/i) ||
    all.match(/(\d+)\s+to\s+(\d+)\s+players?/i);
  if (m) stats.players = m[1] === m[2] ? m[1] : `${m[1]}-${m[2]}`;

  m = all.match(/(\d+)\s*to\s*(\d+)\s*minutes/i) || all.match(/\b(\d+)\s*minutes\b/i);
  if (m) stats.playtimeMinutes = Number(m[1]);

  m = all.match(/\bages?\s*:?\s*(\d+)(\+?)/i);
  if (m) stats.ageRating = m[1] + (m[2] || "");

  return stats;
}

async function generateCatalog(title: string, context: string): Promise<{ description: string; players: string | null; playtimeMinutes: number | null; ageRating: string | null; tags: string[] } | null> {
  const key = process.env.UNSLOTH_API_KEY;
  if (!key) return null;

  const BASE_URL = process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";
  const MODEL = process.env.UNSLOTH_MODEL ?? "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.4,
          max_tokens: 4000,
          messages: [
            { role: "system", content: "You fill out catalog entries for a cozy board game website. You always answer with a single valid JSON object and nothing else." },
            {
              role: "user",
              content:
                `Using ONLY the rulebook excerpts below, return ONE valid JSON object for the board game "${title}" with exactly these keys:\n` +
                '{\n' +
                '  "description": string,     // one paragraph, 90-140 words. Theme, lore and setting first.\n' +
                '  "players": string or null,\n' +
                '  "playtimeMinutes": number or null,\n' +
                '  "ageRating": string or null,\n' +
                '  "tags": array of strings\n' +
                '}\n' +
                "Return ONLY the JSON object — no markdown, no code fences.",
            },
            { role: "user", content: `Rulebook excerpts:\n${context}` },
          ],
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      let raw = (data.choices?.[0]?.message?.content ?? "").trim();
      raw = raw.replace(/^["']|["']$/g, "");

      // Try to parse as JSON.
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end === -1) continue;

      try {
        const obj = JSON.parse(raw.slice(start, end + 1));
        return {
          description: typeof obj.description === "string" ? obj.description.trim() : "",
          players: typeof obj.players === "string" ? obj.players : null,
          playtimeMinutes: typeof obj.playtimeMinutes === "number" ? obj.playtimeMinutes : null,
          ageRating: typeof obj.ageRating === "string" ? obj.ageRating : null,
          tags: Array.isArray(obj.tags) ? obj.tags.map((t: any) => String(t).toLowerCase()) : [],
        };
      } catch {
        // Fallback: use raw text as description.
        return { description: raw, players: null, playtimeMinutes: null, ageRating: null, tags: [] };
      }
    } catch {
      continue;
    }
  }
  return null;
}
