import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { listGames, invalidateGamesCache } from "@/lib/games";
import { digestRulebook } from "@/lib/digest-rulebook.mjs";
import { renderCoverFromPdf } from "@/lib/render-cover.mjs";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form" }, { status: 400 });
  }

  const title = String(form.get("title") ?? "").trim();
  if (!title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const cover = form.get("cover") as File | null;
  const pdf = form.get("pdf") as File | null;
  if (!pdf || pdf.size === 0) {
    return NextResponse.json({ error: "A rulebook PDF is required" }, { status: 400 });
  }
  if (pdf.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "Rulebook PDF is too large (100 MB max)" }, { status: 413 });
  }
  if (cover && cover.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "Cover image is too large (100 MB max)" }, { status: 413 });
  }

  const baseSlug = slugify(title);
  if (!baseSlug) {
    return NextResponse.json({ error: "Title could not be converted to a slug" }, { status: 400 });
  }
  const taken = new Set(listGames().map((g) => g.slug));
  let slug = baseSlug;
  let n = 2;
  while (taken.has(slug)) slug = `${baseSlug}-${n++}`;

  const dir = path.join(process.cwd(), "content", "games", slug);
  fs.mkdirSync(dir, { recursive: true });

  // Save the rulebook; save a cover if one was provided, or render one from page 1.
  const pdfPath = path.join(dir, "rules.pdf");
  fs.writeFileSync(pdfPath, Buffer.from(await pdf.arrayBuffer()));

  let hasCover = !!cover && cover.size > 0;
  if (hasCover && cover) {
    fs.writeFileSync(path.join(dir, "cover.jpg"), Buffer.from(await cover.arrayBuffer()));
  } else {
    // No cover provided — render the first page of the rulebook as the cover.
    try {
      await renderCoverFromPdf(pdfPath, path.join(dir, "cover.jpg"));
      hasCover = true;
    } catch (e) {
      console.warn(`Cover render failed for ${slug}:`, e instanceof Error ? e.message : e);
      // Non-fatal — the game works without a cover.
    }
  }

  const meta = {
    title,
    description: "", // filled in by the async digest job
    image: hasCover ? "cover.jpg" : undefined,
    pdf: "rules.pdf",
    players: String(form.get("players") ?? "").trim() || undefined,
    playtimeMinutes: Number(String(form.get("playtimeMinutes") ?? "")) || undefined,
    ageRating: String(form.get("ageRating") ?? "").trim() || undefined,
    tags: String(form.get("tags") ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  invalidateGamesCache();

  // Fire-and-forget: digest the rulebook (search index + LLM description).
  // The response returns immediately; the game is navigable right away.
  void digestRulebook(slug).catch((e) =>
    console.error(`digest ${slug} failed:`, e instanceof Error ? e.message : e)
  );

  return NextResponse.json({ slug }, { status: 201 });
}
