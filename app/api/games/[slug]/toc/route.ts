import { NextResponse } from "next/server";
import { getGame } from "@/lib/games";
import { loadIndex, pageToc } from "@/lib/retrieve";

/**
 * Per-page table of contents for a game's rulebook: one short label per page
 * that has extracted text. The PDF viewer merges this with its own page count
 * so every page is listed (labelled where we have text) and tap-to-jump works
 * across the whole book.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!getGame(slug)) {
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }
  const chunks = loadIndex().filter((c) => c.slug === slug);
  return NextResponse.json({ toc: pageToc(chunks) });
}
