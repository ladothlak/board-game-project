import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getGame, type Suggestion } from "@/lib/games";

const FIELDS = new Set(["players", "playtimeMinutes", "ageRating"]);

/**
 * Accept or dismiss a metadata suggestion on a game.
 *   accept  -> set meta[field] to the suggested value and drop the suggestion
 *   dismiss -> drop the suggestion (the user's value stays)
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const { slug } = await ctx.params;
  if (!(await getGame(slug))) {
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }

  let body: { field?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const { field, action } = body;
  if (
    typeof field !== "string" ||
    !FIELDS.has(field) ||
    (action !== "accept" && action !== "dismiss")
  ) {
    return NextResponse.json(
      { error: "field must be players, playtimeMinutes, or ageRating; action must be accept or dismiss" },
      { status: 400 }
    );
  }

  const metaPath = path.join(process.cwd(), "content", "games", slug, "meta.json");
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  const suggestions: Suggestion[] = Array.isArray(meta.suggestions) ? meta.suggestions : [];
  const idx = suggestions.findIndex((s) => s.field === field);
  if (idx === -1) {
    return NextResponse.json({ error: "No such suggestion" }, { status: 404 });
  }

  if (action === "accept") {
    meta[field] = suggestions[idx].suggested;
  }
  suggestions.splice(idx, 1);
  meta.suggestions = suggestions;

  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

  return NextResponse.json({
    field,
    value: meta[field],
    suggestions,
  });
}
