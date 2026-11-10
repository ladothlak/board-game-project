import { NextResponse } from "next/server";
import { getGame } from "@/lib/games";
import {
  generateConcepts,
  readConcepts,
  writeConcepts,
} from "@/lib/generate-concepts";
import { requireAuth } from "@/lib/auth";

const BASE_URL = process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const game = await getGame(slug);
  if (!game) {
    return NextResponse.json({ error: "Game not found" }, { status: 404 });
  }

  const stored = await readConcepts(slug);
  if (stored) {
    return NextResponse.json(stored);
  }

  // No stored concepts yet — return empty so the UI can show a "Generate" button.
  return NextResponse.json({ game: slug, generatedAt: null, concepts: [] });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const denied = requireAuth(req as any);
  if (denied) return denied;
  const { slug } = await params;
  const game = await getGame(slug);
  if (!game) {
    return NextResponse.json({ error: "Game not found" }, { status: 404 });
  }

  const apiKey = process.env.UNSLOTH_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "UNSLOTH_API_KEY not set" },
      { status: 500 }
    );
  }

  try {
    const concepts = await generateConcepts(slug, apiKey);
    await writeConcepts(slug, concepts);
    return NextResponse.json({
      game: slug,
      generatedAt: new Date().toISOString(),
      concepts,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Generation failed" },
      { status: 500 }
    );
  }
}
