import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { listGames } from "@/lib/games";
import { requireAuth } from "@/lib/auth";

/**
 * Map of slug → most recent play date (ISO), across all games on the shelf.
 * The game-night picker uses this to gently steer away from games the group
 * just played.
 */
export async function GET(req: Request) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const lastPlayed: Record<string, string> = {};
  for (const g of await listGames()) {
    const p = path.join(process.cwd(), "content", "games", g.slug, "plays.json");
    try {
      const data = JSON.parse(await fs.readFile(p, "utf8"));
      const plays: { date: string }[] = Array.isArray(data.plays) ? data.plays : [];
      if (plays.length > 0) {
        lastPlayed[g.slug] = plays
          .map((x) => x.date)
          .sort()
          .at(-1) as string;
      }
    } catch {
      /* ignore */
    }
  }
  return NextResponse.json({ lastPlayed });
}
