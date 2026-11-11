import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { lookupGame } from "@/lib/lookup";

/**
 * Look up a board game by name. Tries BGG first (most complete data),
 * falls back to Wikipedia's API if BGG is unreachable or blocks us, then a
 * wider web search restricted to official publisher sources. Uses fuzzy name
 * matching and an optional publisher hint for disambiguation.
 * No API key required — just fetches public pages.
 *
 * The lookup logic itself lives in @/lib/lookup so the bulk endpoint can
 * share it.
 */

export async function POST(req: Request) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const start = Date.now();
  const ip = getClientIp(req);

  // Rate limit: 5 per minute (be polite to external sites).
  const rate = checkRate(ip, "/api/games/lookup", 5, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: "/api/games/lookup", method: "POST", status: 429, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Too many lookups — wait a minute." }, { status: 429 });
  }

  let body: { name?: string; publisher?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    logRequest({ ip, route: "/api/games/lookup", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Game name is required" }, { status: 400 });
  }

  const publisher = body.publisher?.trim() ?? null;

  const result = await lookupGame(name, publisher);
  if (result) {
    logRequest({ ip, route: "/api/games/lookup", method: "POST", status: 200, durationMs: Date.now() - start });
    return NextResponse.json(result);
  }

  logRequest({ ip, route: "/api/games/lookup", method: "POST", status: 404, durationMs: Date.now() - start });
  return NextResponse.json(
    { error: `No results found for "${name}". Try a shorter name or add the publisher.` },
    { status: 404 }
  );
}
