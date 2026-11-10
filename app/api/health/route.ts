import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { listGames } from "@/lib/games";

const BASE_URL = process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";

/**
 * Lightweight status probe for the home page: is the local LLM provider up,
 * how fresh is the search index, and how many games are on the shelf. Lets a
 * visitor see at a glance why chat might be quiet without debugging.
 */
export async function GET() {
  let provider = false;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${BASE_URL}/models`, { signal: controller.signal });
    clearTimeout(t);
    provider = res.ok;
  } catch {
    provider = false;
  }

  let indexMtime: string | null = null;
  const indexPath = path.join(process.cwd(), "public", "search-index.json");
  if (fs.existsSync(indexPath)) {
    try {
      indexMtime = new Date(fs.statSync(indexPath).mtimeMs).toISOString();
    } catch {
      indexMtime = null;
    }
  }

  return NextResponse.json({
    provider,
    indexMtime,
    gameCount: listGames().length,
  });
}
