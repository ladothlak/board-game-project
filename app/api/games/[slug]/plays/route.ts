import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getGame } from "@/lib/games";
import { requireAuth } from "@/lib/auth";

interface Play {
  date: string;
  players?: number;
}

async function playsPath(slug: string): Promise<string | null> {
  if (!(await getGame(slug))) return null;
  return path.join(process.cwd(), "content", "games", slug, "plays.json");
}

async function readPlays(p: string): Promise<Play[]> {
  try {
    const data = JSON.parse(await fs.readFile(p, "utf8"));
    return Array.isArray(data.plays) ? data.plays : [];
  } catch {
    return [];
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const { slug } = await ctx.params;
  const p = await playsPath(slug);
  if (!p) return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  const plays = (await readPlays(p)).sort((a, b) => b.date.localeCompare(a.date));
  return NextResponse.json({ plays });
}

/** Log that the group played this game tonight (optionally with headcount). */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const { slug } = await ctx.params;
  const p = await playsPath(slug);
  if (!p) return NextResponse.json({ error: "Unknown game" }, { status: 404 });

  let body: { players?: number };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const players =
    Number.isFinite(Number(body.players)) && Number(body.players) > 0
      ? Math.floor(Number(body.players))
      : undefined;

  const plays = await readPlays(p);
  plays.push({ date: new Date().toISOString(), players });
  plays.sort((a, b) => b.date.localeCompare(a.date));
  await fs.writeFile(p, JSON.stringify({ plays: plays.slice(0, 500), updatedAt: new Date().toISOString() }, null, 2));
  return NextResponse.json({ plays: plays.slice(0, 500) });
}
