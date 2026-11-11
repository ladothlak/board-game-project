import { NextResponse } from "next/server";
import { listGames } from "@/lib/games";

/**
 * Returns the current shelf games with their metadata (including
 * descriptions). Used by the client to poll for digest updates so game
 * cards reflect newly generated descriptions without a page refresh.
 */
export async function GET() {
  const games = await listGames();
  return NextResponse.json({
    games: games.map((g) => ({
      slug: g.slug,
      title: g.title,
      description: g.description,
      image: g.image,
      players: g.players,
      playtimeMinutes: g.playtimeMinutes,
      ageRating: g.ageRating,
      tags: g.tags,
      complexity: g.complexity,
    })),
  });
}
