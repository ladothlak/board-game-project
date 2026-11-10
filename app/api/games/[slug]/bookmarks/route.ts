import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getGame } from "@/lib/games";

interface Bookmark {
  page: number;
  label: string;
}

async function bookmarksPath(slug: string): Promise<string | null> {
  if (!(await getGame(slug))) return null;
  return path.join(process.cwd(), "content", "games", slug, "bookmarks.json");
}

async function readBookmarks(p: string): Promise<Bookmark[]> {
  try {
    const data = JSON.parse(await fs.readFile(p, "utf8"));
    return Array.isArray(data.bookmarks) ? data.bookmarks : [];
  } catch {
    return [];
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const p = await bookmarksPath(slug);
  if (!p) return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  return NextResponse.json({ bookmarks: await readBookmarks(p) });
}

/**
 * Add (or update, by page) a bookmark. One bookmark per page: re-adding the
 * same page overwrites its label so the list stays tidy.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const p = await bookmarksPath(slug);
  if (!p) return NextResponse.json({ error: "Unknown game" }, { status: 404 });

  let body: { page?: number; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const page = Math.floor(Number(body.page));
  if (!Number.isFinite(page) || page < 1) {
    return NextResponse.json({ error: "page is required" }, { status: 400 });
  }
  const label = (body.label ?? "").trim().slice(0, 200);

  const bookmarks = (await readBookmarks(p)).filter((b) => b.page !== page);
  bookmarks.push({ page, label });
  bookmarks.sort((a, b) => a.page - b.page);
  await fs.writeFile(p, JSON.stringify({ bookmarks, updatedAt: new Date().toISOString() }, null, 2));
  return NextResponse.json({ bookmarks });
}

/** Remove the bookmark for a single page (?page=N). */
export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const p = await bookmarksPath(slug);
  if (!p) return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  const page = Number(new URL(req.url).searchParams.get("page"));

  const bookmarks = (await readBookmarks(p)).filter((b) => b.page !== page);
  await fs.writeFile(p, JSON.stringify({ bookmarks, updatedAt: new Date().toISOString() }, null, 2));
  return NextResponse.json({ bookmarks });
}
