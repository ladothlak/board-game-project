import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * Serve a game's asset (cover image or rulebook PDF) straight from
 * content/games/<slug>/ on demand. This avoids relying on Next.js's
 * static `public/` serving, which snapshots the directory at build time
 * and will not serve files added at runtime without a restart.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const { slug } = await ctx.params;
  const name = new URL(req.url).searchParams.get("name") ?? "";

  // Only allow a single path segment (no directories, no traversal).
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
  }
  const ext = path.extname(name).toLowerCase();
  if (!(ext in MIME)) {
    return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
  }

  const dir = path.join(process.cwd(), "content", "games", slug);
  const filePath = path.join(dir, name);

  // Defense in depth: ensure the resolved path stays inside the game dir.
  const realDir = fs.realpathSync(dir) + path.sep;
  const realFile = fs.realpathSync(filePath);
  if (!realFile.startsWith(realDir)) {
    return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
  }
  if (!fs.existsSync(realFile)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const bytes = fs.readFileSync(realFile);

  // ETag based on file size + mtime (cheap, no hashing needed for local files).
  const stat = fs.statSync(realFile);
  const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }

  const res = new NextResponse(bytes);
  res.headers.set("Content-Type", MIME[ext]);
  res.headers.set("ETag", etag);
  // PDFs and images are immutable at runtime — cache aggressively.
  res.headers.set("Cache-Control", "public, max-age=86400");
  return res;
}
