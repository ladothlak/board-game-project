import { NextResponse } from "next/server";
import { listGames } from "@/lib/games";

/**
 * Returns the slugs currently on the shelf. Hidden and deleted games are
 * both excluded (listGames() only returns games that exist and aren't
 * hidden). Used to keep search results in sync with the shelf at runtime,
 * since the static search index is built at build time.
 */
export async function GET() {
  const slugs = (await listGames()).map((g) => g.slug);
  return NextResponse.json({ slugs });
}
