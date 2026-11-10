import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getGame, invalidateGamesCache } from "@/lib/games";
import { generatePairs } from "@/lib/generate-pairs";
import { logRequest } from "@/lib/audit-log";

const start = Date.now();

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const game = getGame(slug);
  if (!game) {
    logRequest({ ip: "", route: `/api/games/${slug}/pairs`, method: "GET", status: 404, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Game not found" }, { status: 404 });
  }

  // Return cached pairs if they exist.
  if (game.pairsWith && game.pairsWith.length > 0) {
    logRequest({ ip: "", route: `/api/games/${slug}/pairs`, method: "GET", status: 200, durationMs: Date.now() - start });
    return NextResponse.json({ pairs: game.pairsWith });
  }

  // No cached pairs — generate them now.
  const apiKey = process.env.UNSLOTH_API_KEY ?? "";
  if (!apiKey) {
    logRequest({ ip: "", route: `/api/games/${slug}/pairs`, method: "GET", status: 503, durationMs: Date.now() - start });
    return NextResponse.json({ error: "LLM not configured" }, { status: 503 });
  }

  try {
    const pairs = await generatePairs(slug, apiKey);
    if (pairs.length > 0) {
      // Persist to meta.json.
      const metaPath = path.join(process.cwd(), "content", "games", slug, "meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      meta.pairsWith = pairs;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
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
