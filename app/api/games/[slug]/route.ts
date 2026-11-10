import { NextResponse } from "next/server";
import { getGame } from "@/lib/games";
import { digestRulebook } from "@/lib/digest-rulebook.mjs";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const game = getGame(slug);
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
  if (!getGame(slug)) {
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }
  void digestRulebook(slug).catch((e) =>
    console.error(`digest ${slug} failed:`, e instanceof Error ? e.message : e)
  );
  return NextResponse.json({ ok: true }, { status: 202 });
}
