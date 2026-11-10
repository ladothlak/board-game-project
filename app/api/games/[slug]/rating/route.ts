import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getGame } from "@/lib/games";
import { requireAuth } from "@/lib/auth";

function ratingPath(slug: string): string | null {
  if (!getGame(slug)) return null;
  return path.join(process.cwd(), "content", "games", slug, "rating.json");
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const { slug } = await ctx.params;
  const p = ratingPath(slug);
  if (!p) return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  if (!fs.existsSync(p)) return NextResponse.json({ stars: null });
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return NextResponse.json({ stars: data.stars ?? null });
  } catch {
    return NextResponse.json({ stars: null });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const { slug } = await ctx.params;
  const p = ratingPath(slug);
  if (!p) return NextResponse.json({ error: "Unknown game" }, { status: 404 });

  let body: { stars?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const stars = Math.floor(Number(body.stars));
  if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
    return NextResponse.json({ error: "stars must be between 1 and 5" }, { status: 400 });
  }

  fs.writeFileSync(p, JSON.stringify({ stars, updatedAt: new Date().toISOString() }, null, 2));
  return NextResponse.json({ stars });
}
