import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getGame, invalidateGamesCache } from "@/lib/games";

/**
 * Take a game off the shelf, two ways:
 *   hide   -> set meta.hidden = true. Everything stays on disk (rulebook,
 *             cover, notes, metadata) and the game can be brought back.
 *   delete -> remove the whole content/games/<slug>/ directory. Destructive.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const { slug } = await ctx.params;
  if (!(await getGame(slug))) {
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }

  let body: { mode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const dir = path.join(process.cwd(), "content", "games", slug);

  if (body.mode === "hide") {
    const metaPath = path.join(dir, "meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.hidden = true;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    invalidateGamesCache();
    return NextResponse.json({ mode: "hide", hidden: true });
  }

  if (body.mode === "restore") {
    const metaPath = path.join(dir, "meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    delete meta.hidden;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    invalidateGamesCache();
    return NextResponse.json({ mode: "restore", hidden: false });
  }

  if (body.mode === "delete") {
    await fs.rm(dir, { recursive: true, force: true });
    invalidateGamesCache();
    return NextResponse.json({ mode: "delete", deleted: true });
  }

  return NextResponse.json(
    { error: "mode must be 'hide', 'restore', or 'delete'" },
    { status: 400 }
  );
}
