import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getGame, invalidateGamesCache, listGames, type GameMeta } from "@/lib/games";
import { generatePairs } from "@/lib/generate-pairs";
import { logRequest } from "@/lib/audit-log";

/**
 * Fingerprint of the current shelf (same format as find-game): sorted
 * "slug:title" pairs joined with "|". If any game is added or removed,
 * this changes and cached pairs are regenerated on the next visit.
 */
function computeFingerprint(games: GameMeta[]): string {
  return games.map((g) => `${g.slug}:${g.title}`).sort().join("|");
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const start = Date.now();
  const { slug } = await params;
  const game = await getGame(slug);
  if (!game) {
    logRequest({ ip: "", route: `/api/games/${slug}/pairs`, method: "GET", status: 404, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Game not found" }, { status: 404 });
  }

  // Return cached pairs if they exist AND the shelf hasn't changed since
  // they were generated. A stale fingerprint (or a missing one from older
  // data) means games were added/removed, so we regenerate below.
  const currentFingerprint = computeFingerprint(await listGames());
  if (game.pairsWith && game.pairsWith.length > 0 && game.pairsFingerprint === currentFingerprint) {
    logRequest({ ip: "", route: `/api/games/${slug}/pairs`, method: "GET", status: 200, durationMs: Date.now() - start });
    return NextResponse.json({ pairs: game.pairsWith });
  }

  // No cached pairs (or the shelf changed) — generate them now.
  const apiKey = process.env.UNSLOTH_API_KEY ?? "";
  if (!apiKey) {
    logRequest({ ip: "", route: `/api/games/${slug}/pairs`, method: "GET", status: 503, durationMs: Date.now() - start });
    return NextResponse.json({ error: "LLM not configured" }, { status: 503 });
  }

  try {
    const pairs = await generatePairs(slug, apiKey);
    if (pairs.length > 0) {
      // Persist to meta.json along with the shelf fingerprint so we can
      // tell when the shelf changes and needs a re-generation.
      const metaPath = path.join(process.cwd(), "content", "games", slug, "meta.json");
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      meta.pairsWith = pairs;
      meta.pairsFingerprint = currentFingerprint;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
      invalidateGamesCache();
    }
    logRequest({ ip: "", route: `/api/games/${slug}/pairs`, method: "GET", status: 200, durationMs: Date.now() - start });
    return NextResponse.json({ pairs });
  } catch (e) {
    console.error(`Failed to generate pairs for ${slug}:`, e);
    logRequest({ ip: "", route: `/api/games/${slug}/pairs`, method: "GET", status: 500, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: "Couldn't generate pair suggestions right now." },
      { status: 500 }
    );
  }
}
