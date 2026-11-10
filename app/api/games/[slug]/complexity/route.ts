import { NextRequest, NextResponse } from "next/server";
import { getGame } from "@/lib/games";
import fs from "fs";
import path from "path";

const UNSLOTH_URL = process.env.UNSLOTH_URL ?? "http://localhost:8888/v1";
const MODEL = process.env.UNSLOTH_MODEL ?? "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";

/**
 * Estimates a 1–5 complexity score for a game using the LLM.
 * Stored in meta.json as `complexity` so it's available on every page load.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const slug: string = body.slug;
  if (!slug) {
    return NextResponse.json({ error: "No slug provided." }, { status: 400 });
  }

  const game = getGame(slug);
  if (!game) {
    return NextResponse.json({ error: `Unknown game: ${slug}` }, { status: 404 });
  }

  // If already scored, return it.
  if (game.complexity != null) {
    return NextResponse.json({ complexity: game.complexity });
  }

  const apiKey = process.env.UNSLOTH_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "UNSLOTH_API_KEY is not set" },
      { status: 500 }
    );
  }

  const system = `You are a board game expert. Estimate the complexity of this game on a scale of 1 (very simple, like Tic-Tac-Toe) to 5 (very heavy, like a 12-hour campaign). Consider: number of rules, resource management depth, player interaction, setup time, and how much strategy vs. luck is involved.

Game: ${game.title}
Description: ${game.description ?? ""}
Tags: ${(game.tags ?? []).join(", ")}
Players: ${game.players ?? "?"}
Playtime: ${game.playtimeMinutes != null ? `~${game.playtimeMinutes} min` : "?"}

Respond with ONLY a single integer from 1 to 5. No other text.`;

  try {
    const res = await fetch(`${UNSLOTH_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }],
        temperature: 0.2,
        max_tokens: 10,
      }),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `LLM returned ${res.status}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? "";
    const score = Math.min(5, Math.max(1, parseInt(text.trim(), 10) || 3));

    // Persist to meta.json.
    const metaPath = path.join(process.cwd(), "content", "games", slug, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.complexity = score;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    return NextResponse.json({ complexity: score });
  } catch {
    return NextResponse.json(
      { error: "Could not reach the LLM." },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "No slug provided." }, { status: 400 });
  }
  const game = getGame(slug);
  if (!game) {
    return NextResponse.json({ error: `Unknown game: ${slug}` }, { status: 404 });
  }
  return NextResponse.json({ complexity: game.complexity ?? null });
}
