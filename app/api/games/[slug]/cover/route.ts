import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import fs from "fs/promises";
import path from "path";
import { getGame, invalidateGamesCache } from "@/lib/games";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { MAX_PDF_SIZE as MAX_FILE_SIZE } from "@/lib/fetch-rulebook-utils";

/**
 * Replace a game's cover photo. Accepts a multipart form with an "image"
 * file field, saves it into content/games/<slug>/ and points meta.image at
 * the new filename. Returns { image: "<filename>" }.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const start = Date.now();
  const { slug } = await ctx.params;
  const ip = getClientIp(req);

  // Rate limit: 5 per minute (image uploads are lighter than PDFs).
  const rate = checkRate(ip, `/api/games/${slug}/cover`, 5, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: `/api/games/${slug}/cover`, method: "POST", status: 429, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Too many uploads — wait a minute." }, { status: 429 });
  }

  const game = await getGame(slug);
  if (!game) {
    logRequest({ ip, route: `/api/games/${slug}/cover`, method: "POST", status: 404, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    logRequest({ ip, route: `/api/games/${slug}/cover`, method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Expected a multipart form" }, { status: 400 });
  }

  const image = form.get("image") as File | null;
  if (!image || image.size === 0) {
    logRequest({ ip, route: `/api/games/${slug}/cover`, method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "An image file is required" }, { status: 400 });
  }
  if (image.size > MAX_FILE_SIZE) {
    logRequest({ ip, route: `/api/games/${slug}/cover`, method: "POST", status: 413, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Image is too large (max 100 MB)" }, { status: 413 });
  }
  // Browsers usually report a content type; reject anything that claims to
  // be something other than an image. (The MIME type is client-controlled, so
  // we also verify the actual file bytes below.)
  if (image.type && !image.type.startsWith("image/")) {
    logRequest({ ip, route: `/api/games/${slug}/cover`, method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "File doesn't look like an image" }, { status: 400 });
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
    logRequest({ ip, route: `/api/games/${slug}/cover`, method: "POST", status: 404, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Game directory not found" }, { status: 404 });
  }

  // Keep the uploaded filename (basename only — no path traversal), falling
  // back to cover.jpg. Replacing a file with the same name overwrites it,
  // which is exactly what "replace cover" means. Require an image extension so
  // the upload can't clobber meta.json or rules.pdf.
  const rawName = image.name.split(/[\\/]/).pop() ?? "";
  const name = rawName.trim() || "cover.jpg";
  if (!/\.(jpe?g|png|webp|gif)$/i.test(name)) {
    logRequest({ ip, route: `/api/games/${slug}/cover`, method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: "File must be a JPEG, PNG, WebP, or GIF image." },
      { status: 400 }
    );
  }

  const bytes = Buffer.from(await image.arrayBuffer());

  // Magic-byte check: the client-reported MIME type is not trustworthy, so
  // verify the actual file signature (mirrors the rulebook route's %PDF check).
  const isJpeg =
    bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng =
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp =
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  const isGif = bytes.subarray(0, 4).toString("ascii") === "GIF8";
  if (!isJpeg && !isPng && !isWebp && !isGif) {
    logRequest({ ip, route: `/api/games/${slug}/cover`, method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: "File doesn't look like a valid image" },
      { status: 400 }
    );
  }

  try {
    await fs.writeFile(path.join(dir, name), bytes);

    // Point meta.json at the new file.
    const metaPath = path.join(dir, "meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.image = name;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  } catch (e) {
    console.error(`cover upload failed for ${slug}:`, e instanceof Error ? e.message : e);
    logRequest({ ip, route: `/api/games/${slug}/cover`, method: "POST", status: 500, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: "Failed to save the cover image" },
      { status: 500 }
    );
  }
  invalidateGamesCache();

  logRequest({ ip, route: `/api/games/${slug}/cover`, method: "POST", status: 200, durationMs: Date.now() - start });
  return NextResponse.json({ image: name });
}
