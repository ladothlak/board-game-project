import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getGame, invalidateGamesCache } from "@/lib/games";
import { digestRulebook } from "@/lib/digest-rulebook.mjs";

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
  const { slug } = await ctx.params;
  if (!(await getGame(slug))) {
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const metaPath = path.join(process.cwd(), "content", "games", slug, "meta.json");
  let meta: Record<string, any>;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch {
    return NextResponse.json({ error: "Game metadata not found" }, { status: 404 });
  }

  // Only update the fields that are present in the body.
  if (typeof body.title === "string" && body.title.trim()) meta.title = body.title.trim();
  if (typeof body.description === "string") meta.description = body.description;
  if (typeof body.players === "string") meta.players = body.players.trim() || undefined;
  if (typeof body.playtimeMinutes === "number" && Number.isFinite(body.playtimeMinutes)) {
    meta.playtimeMinutes = body.playtimeMinutes;
  }
  if (typeof body.ageRating === "string") meta.ageRating = body.ageRating.trim() || undefined;
  if (Array.isArray(body.tags)) {
    meta.tags = body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof body.image === "string") meta.image = body.image.trim() || undefined;

  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  invalidateGamesCache();

  return NextResponse.json(meta);
}
