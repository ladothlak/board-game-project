import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { getGame, invalidateGamesCache } from "@/lib/games";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { MAX_PDF_SIZE as MAX_FILE_SIZE } from "@/lib/fetch-rulebook-utils";

/**
 * POST — Add an expansion to a game.
 * Expects multipart form: name (string), pdf (File).
 * Saves the PDF to content/games/<slug>/expansion-<name>.pdf
 * and updates meta.json with the new expansion entry.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const start = Date.now();
  const ip = getClientIp(req);
  const { slug } = await ctx.params;

  // Rate limit: 3 per minute.
  const rate = checkRate(ip, `/api/games/${slug}/expansions`, 3, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: `/api/games/${slug}/expansions`, method: "POST", status: 429, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Too many requests — wait a minute." }, { status: 429 });
  }

  const game = getGame(slug);
  if (!game) {
    return NextResponse.json({ error: "Game not found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form" }, { status: 400 });
  }

  const name = String(form.get("name") ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "Expansion name is required" }, { status: 400 });
  }

  const pdf = form.get("pdf") as File | null;
  if (!pdf || pdf.size === 0) {
    return NextResponse.json({ error: "A rulebook PDF is required" }, { status: 400 });
  }
  if (pdf.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "PDF is too large (max 100 MB)" }, { status: 413 });
  }

  const dir = path.join(process.cwd(), "content", "games", slug);
  if (!fs.existsSync(dir)) {
    return NextResponse.json({ error: "Game directory not found" }, { status: 404 });
  }

  // Sanitize the filename.
  const fileBase = `expansion-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
  const pdfName = `${fileBase}.pdf`;
  fs.writeFileSync(path.join(dir, pdfName), Buffer.from(await pdf.arrayBuffer()));

  // Update meta.json.
  const metaPath = path.join(dir, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (!meta.expansions) meta.expansions = [];

  // Prevent duplicates.
  if (meta.expansions.some((e: { name: string }) => e.name.toLowerCase() === name.toLowerCase())) {
    return NextResponse.json({ error: `Expansion "${name}" already exists` }, { status: 409 });
  }

  meta.expansions.push({ name, pdf: pdfName });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
  invalidateGamesCache();

  logRequest({ ip, route: `/api/games/${slug}/expansions`, method: "POST", status: 201, durationMs: Date.now() - start });
  return NextResponse.json({ name, pdf: pdfName }, { status: 201 });
}

/**
 * DELETE — Remove an expansion from a game.
 * Expects JSON body: { name: string }
 * Deletes the PDF file and removes the entry from meta.json.
 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const start = Date.now();
  const ip = getClientIp(req);
  const { slug } = await ctx.params;

  const game = getGame(slug);
  if (!game) {
    return NextResponse.json({ error: "Game not found" }, { status: 404 });
  }

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "Expansion name is required" }, { status: 400 });
  }

  const dir = path.join(process.cwd(), "content", "games", slug);
  const metaPath = path.join(dir, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

  const idx = (meta.expansions ?? []).findIndex(
    (e: { name: string }) => e.name.toLowerCase() === name.toLowerCase()
  );
  if (idx === -1) {
    return NextResponse.json({ error: `Expansion "${name}" not found` }, { status: 404 });
  }

  const removed = meta.expansions[idx];
  // Delete the PDF file.
  try {
    fs.unlinkSync(path.join(dir, removed.pdf));
  } catch {
    /* file might already be gone */
  }

  // Remove its chunks from the search index if it was in chat context.
  if (removed.inChatContext) {
    const nameSlug = removed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    removeExpansionChunks(`${slug}-exp-${nameSlug}`);
  }

  meta.expansions.splice(idx, 1);
  if (meta.expansions.length === 0) delete meta.expansions;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
  invalidateGamesCache();

  logRequest({ ip, route: `/api/games/${slug}/expansions`, method: "DELETE", status: 200, durationMs: Date.now() - start });
  return NextResponse.json({ removed: name });
}

/**
 * PATCH — Toggle an expansion's inclusion in the chat (RAG) context.
 * Expects JSON body: { name: string, inChatContext: boolean }
 * When enabling: extracts PDF text and adds chunks to search-index.json.
 * When disabling: removes the expansion's chunks from search-index.json.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const start = Date.now();
  const ip = getClientIp(req);
  const { slug } = await ctx.params;

  const game = getGame(slug);
  if (!game) {
    return NextResponse.json({ error: "Game not found" }, { status: 404 });
  }

  let body: { name?: string; inChatContext?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name || typeof body.inChatContext !== "boolean") {
    return NextResponse.json({ error: "Name and inChatContext (boolean) are required" }, { status: 400 });
  }

  const dir = path.join(process.cwd(), "content", "games", slug);
  const metaPath = path.join(dir, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

  const idx = (meta.expansions ?? []).findIndex(
    (e: { name: string }) => e.name.toLowerCase() === name.toLowerCase()
  );
  if (idx === -1) {
    return NextResponse.json({ error: `Expansion "${name}" not found` }, { status: 404 });
  }

  // Update the flag.
  meta.expansions[idx].inChatContext = body.inChatContext;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
  invalidateGamesCache();

  // Update the search index.
  const nameSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const idPrefix = `${slug}-exp-${nameSlug}`;

  if (body.inChatContext) {
    // Extract text from the expansion PDF and add chunks.
    const pdfPath = path.join(dir, meta.expansions[idx].pdf);
    if (!fs.existsSync(pdfPath)) {
      return NextResponse.json({ error: "Expansion PDF file not found" }, { status: 404 });
    }

    const pages = await extractPdf(pdfPath);
    addExpansionChunks(slug, meta.title ?? slug, idPrefix, pages);
  } else {
    // Remove the expansion's chunks.
    removeExpansionChunks(idPrefix);
  }

  logRequest({ ip, route: `/api/games/${slug}/expansions`, method: "PATCH", status: 200, durationMs: Date.now() - start });
  return NextResponse.json({ name, inChatContext: body.inChatContext });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

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

function addExpansionChunks(slug: string, title: string, idPrefix: string, pages: string[]) {
  const outPath = path.join(process.cwd(), "public", "search-index.json");
  let index = { entries: [] as any[] };
  if (fs.existsSync(outPath)) {
    try {
      index = JSON.parse(fs.readFileSync(outPath, "utf8"));
    } catch { /* start fresh */ }
  }
  // Remove any existing chunks for this expansion (in case of re-toggle).
  const entries = (index.entries ?? []).filter((e: any) => !e.id.startsWith(idPrefix));

  // Offset page numbers so they don't collide with the base game's pages.
  const baseChunks = entries.filter((e: any) => e.slug === slug && !e.id.includes("-exp-"));
  const maxBasePage = baseChunks.length > 0 ? Math.max(...baseChunks.map((e: any) => e.page)) : 0;
  pages.forEach((text, i) => {
    const clean = (text ?? "").replace(/\s+/g, " ").trim();
    if (clean) {
      entries.push({ id: `${idPrefix}-p${i + 1}`, slug, title, page: maxBasePage + i + 1, text: clean });
    }
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2));
}

function removeExpansionChunks(idPrefix: string) {
  const outPath = path.join(process.cwd(), "public", "search-index.json");
  if (!fs.existsSync(outPath)) return;
  let index = { entries: [] as any[] };
  try {
    index = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch { return; }
  const entries = (index.entries ?? []).filter((e: any) => !e.id.startsWith(idPrefix));
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2));
}
