import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getGame, listGames } from "@/lib/games";
import { requireAuth } from "@/lib/auth";

function notesPath(slug: string): string | null {
  if (!getGame(slug)) return null;
  return path.join(process.cwd(), "content", "games", slug, "notes.json");
}

export async function GET(req: Request) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  const p = notesPath(slug);
  if (!p) return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  if (!fs.existsSync(p)) return NextResponse.json({ text: "", updatedAt: null });
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ text: "", updatedAt: null });
  }
}

export async function POST(req: Request) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  const p = notesPath(slug);
  if (!p) return NextResponse.json({ error: "Unknown game" }, { status: 404 });

  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const text = (body.text ?? "").slice(0, 20000);

  fs.writeFileSync(p, JSON.stringify({ text, updatedAt: new Date().toISOString() }, null, 2));
  return NextResponse.json({ text, updatedAt: new Date().toISOString() });
}
