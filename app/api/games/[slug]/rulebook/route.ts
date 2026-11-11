import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { getGame, invalidateGamesCache } from "@/lib/games";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { MAX_PDF_SIZE } from "@/lib/fetch-rulebook-utils";

/**
 * Replace a game's rulebook PDF and re-digest all LLM-generated content.
 * Accepts a multipart form with a "pdf" file field.
 *
 * Steps:
 * 1. Save the new PDF (replacing the old one).
 * 2. Remove old generated content (concepts, checklist).
 * 3. Re-extract text + rebuild the search index for this slug.
 * 4. Regenerate the LLM description + metadata.
 * 5. Update complexity score.
 * 6. Invalidate in-memory caches.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const start = Date.now();
  const { slug } = await ctx.params;
  const ip = getClientIp(req);

  // Rate limit: 3 per minute (PDF uploads are heavy).
  const rate = checkRate(ip, `/api/games/${slug}/rulebook`, 3, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: `/api/games/${slug}/rulebook`, method: "POST", status: 429, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Too many uploads — wait a minute." }, { status: 429 });
  }

  const game = await getGame(slug);
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
  let dirOk = false;
  try {
    await fs.stat(dir);
    dirOk = true;
  } catch {
    /* directory missing */
  }
  if (!dirOk) {
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

  await fs.writeFile(pdfPath, bytes);

  // Update meta.json to point to the new file (in case the filename changed).
  const metaPath = path.join(dir, "meta.json");
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  meta.pdf = pdfName;
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

  invalidateGamesCache();

  // Write the digesting marker BEFORE responding, so the client's first poll
  // can never race ahead of it and see done:true while the digest is still
  // in flight. reDigest only ever removes the marker (in its finally block).
  await fs.writeFile(path.join(dir, ".digesting"), new Date().toISOString());

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
 * If the marker is stale (>30 min), assumes the server crashed and reports done.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const { slug } = await ctx.params;

  // Check if the digest is still in flight.
  const statusPath = path.join(process.cwd(), "content", "games", slug, ".digesting");
  let st: import("fs").Stats | null = null;
  try {
    st = await fs.stat(statusPath);
  } catch {
    /* no marker — digest complete */
  }
  if (st) {
    // Stale marker (>30 min) means the server crashed mid-digest.
    const age = Date.now() - st.mtimeMs;
    if (age < 30 * 60_000) {
      return NextResponse.json({ done: false });
    }
    // Clean up the stale marker.
    try { await fs.unlink(statusPath); } catch { /* already gone */ }
  }

  return NextResponse.json({ done: true });
}

// ─── Re-digest logic ──────────────────────────────────────────────────────

async function reDigest(slug: string) {
  const dir = path.join(process.cwd(), "content", "games", slug);
  const metaPath = path.join(dir, "meta.json");

  // The .digesting marker is written by the POST handler before it responds,
  // so this function only ever removes it (in the finally block below).
  try {
    // Remove old generated content so the UI shows "not loaded" state
    // until the user manually triggers regeneration.
    for (const f of ["concepts.json", "checklist.json"]) {
      try { await fs.unlink(path.join(dir, f)); } catch { /* already gone */ }
    }

    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    const pdfPath = path.join(dir, meta.pdf ?? "rules.pdf");

    // 1. Extract text from the PDF (child process).
    const pages = await extractPdf(pdfPath);

    // 2. Rebuild the search index for this slug.
    await rebuildIndexFor(slug, meta.title ?? slug, pages);

    // 3. Regenerate description + metadata via LLM.
    if (pages.some((p) => (p ?? "").trim().length > 0)) {
      const catalog = await generateCatalog(meta.title ?? slug, buildContext(pages));
      if (catalog?.description) {
        meta.description = catalog.description;
        // Overwrite metadata fields with values from the new rulebook.
        const stats = extractStats(pages);
        if (stats.players) meta.players = stats.players;
        if (stats.playtimeMinutes != null) meta.playtimeMinutes = stats.playtimeMinutes;
        if (stats.ageRating) meta.ageRating = stats.ageRating;
        if (catalog.tags.length > 0) {
          meta.tags = catalog.tags;
        }
      }
    }

    // 4. Update complexity score.
    const apiKey = process.env.UNSLOTH_API_KEY;
    if (apiKey) {
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

    // Persist updated meta. Re-read from disk to avoid clobbering concurrent
    // changes (e.g. a PATCH from the edit modal that landed during digest).
    const freshMeta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    if (meta.description) freshMeta.description = meta.description;
    if (meta.players) freshMeta.players = meta.players;
    if (meta.playtimeMinutes != null) freshMeta.playtimeMinutes = meta.playtimeMinutes;
    if (meta.ageRating) freshMeta.ageRating = meta.ageRating;
    if (meta.tags?.length) freshMeta.tags = meta.tags;
    if (meta.complexity != null) freshMeta.complexity = meta.complexity;
    await fs.writeFile(metaPath, JSON.stringify(freshMeta, null, 2));
    invalidateGamesCache();
  } finally {
    // Clear the digesting marker.
    const statusPath = path.join(dir, ".digesting");
    try {
      await fs.unlink(statusPath);
    } catch {
      /* marker already gone */
    }
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

async function rebuildIndexFor(slug: string, title: string, pages: string[]) {
  const outPath = path.join(process.cwd(), "public", "search-index.json");
  let index = { entries: [] as any[] };
  try {
    index = JSON.parse(await fs.readFile(outPath, "utf8"));
  } catch {
    /* start fresh */
  }
  const entries = (index.entries ?? []).filter((e: any) => e.slug !== slug);
  pages.forEach((text, i) => {
    const clean = (text ?? "").replace(/\s+/g, " ").trim();
    if (clean) {
      entries.push({ id: `${slug}-p${i + 1}`, slug, title, page: i + 1, text: clean, isExpansion: false });
    }
  });
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(
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
