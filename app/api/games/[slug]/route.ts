import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getGame, invalidateGamesCache } from "@/lib/games";
import { digestRulebook } from "@/lib/digest-rulebook.mjs";
import { requireAuth } from "@/lib/auth";
import { getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const game = await getGame(slug);
  if (!game) {
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }
  return NextResponse.json({
    slug,
    title: game.title,
    description: game.description ?? "",
  });
}

/**
 * Re-trigger the async digest for a game whose description never landed
 * (e.g., the server restarted mid-generation). No-op if one is already
 * running or the description exists.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!(await getGame(slug))) {
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }
  void digestRulebook(slug).catch((e) =>
    console.error(`digest ${slug} failed:`, e instanceof Error ? e.message : e)
  );
  return NextResponse.json({ ok: true }, { status: 202 });
}

/**
 * Update a game's metadata. Accepts JSON with any subset of the fields
 * title, description, players, playtimeMinutes, ageRating, tags and image —
 * only the fields present in the body are merged into meta.json.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const start = Date.now();
  const { slug } = await ctx.params;
  const ip = getClientIp(req);
  const route = `/api/games/${slug}`;

  if (!(await getGame(slug))) {
    logRequest({ ip, route, method: "PATCH", status: 404, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    logRequest({ ip, route, method: "PATCH", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate a couple of fields before touching the metadata.
  if (
    body.playtimeMinutes != null &&
    (typeof body.playtimeMinutes !== "number" ||
      !Number.isFinite(body.playtimeMinutes) ||
      body.playtimeMinutes < 0)
  ) {
    logRequest({ ip, route, method: "PATCH", status: 400, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: "playtimeMinutes must be a non-negative number" },
      { status: 400 }
    );
  }
  if (typeof body.image === "string" && !/\.(jpe?g|png|webp|gif)$/i.test(body.image)) {
    logRequest({ ip, route, method: "PATCH", status: 400, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: "Image must be a JPEG, PNG, WebP, or GIF file." },
      { status: 400 }
    );
  }

  const metaPath = path.join(process.cwd(), "content", "games", slug, "meta.json");
  let meta: Record<string, any>;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch {
    logRequest({ ip, route, method: "PATCH", status: 404, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Game metadata not found" }, { status: 404 });
  }

  // Only update the fields that are present in the body.
  // null means "clear this field" (e.g. user emptied an input).
  if (typeof body.title === "string" && body.title.trim()) meta.title = body.title.trim();
  if (typeof body.description === "string") meta.description = body.description;
  if (body.players === null) delete meta.players;
  else if (typeof body.players === "string") meta.players = body.players.trim() || undefined;
  if (body.playtimeMinutes === null) delete meta.playtimeMinutes;
  else if (
    typeof body.playtimeMinutes === "number" &&
    Number.isFinite(body.playtimeMinutes) &&
    body.playtimeMinutes >= 0
  ) {
    meta.playtimeMinutes = body.playtimeMinutes;
  }
  if (body.ageRating === null) delete meta.ageRating;
  else if (typeof body.ageRating === "string") meta.ageRating = body.ageRating.trim() || undefined;
  if (Array.isArray(body.tags)) {
    meta.tags = body.tags.filter((t) => typeof t === "string" || typeof t === "number").map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof body.image === "string") meta.image = body.image.trim() || undefined;

  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  invalidateGamesCache();

  logRequest({ ip, route, method: "PATCH", status: 200, durationMs: Date.now() - start });
  return NextResponse.json(meta);
}
