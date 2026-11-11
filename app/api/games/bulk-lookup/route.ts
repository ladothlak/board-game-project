import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { lookupGame } from "@/lib/lookup";

/**
 * Bulk-look up a list of board game names. For each name it runs the same
 * lookup logic used by /api/games/lookup (BGG → Wikipedia → web, via
 * @/lib/lookup) and returns per-name results so the frontend can show a
 * checklist with metadata before adding games to the shelf.
 *
 * Names are looked up SEQUENTIALLY (not in parallel) so we don't hammer
 * Wikipedia — BGG blocks server IPs anyway, so Wikipedia is the workhorse.
 */

const MAX_NAMES = 50;
const MAX_NAME_LENGTH = 200;

interface BulkResult {
  name: string;
  found: boolean;
  title?: string;
  players?: string;
  playtimeMinutes?: number;
  ageRating?: string;
  description?: string;
  tags?: string[];
  publisherName?: string;
}

export async function POST(req: Request) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const start = Date.now();
  const ip = getClientIp(req);

  // Rate limit: 5 per minute (be polite to external sites).
  const rate = checkRate(ip, "/api/games/bulk-lookup", 5, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: "/api/games/bulk-lookup", method: "POST", status: 429, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Too many bulk lookups — wait a minute." }, { status: 429 });
  }

  let body: { names?: unknown };
  try {
    body = await req.json();
  } catch {
    logRequest({ ip, route: "/api/games/bulk-lookup", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body.names;
  if (!Array.isArray(raw)) {
    logRequest({ ip, route: "/api/games/bulk-lookup", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "`names` must be an array" }, { status: 400 });
  }

  // Normalize + validate each name.
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_NAME_LENGTH) {
      logRequest({ ip, route: "/api/games/bulk-lookup", method: "POST", status: 400, durationMs: Date.now() - start });
      return NextResponse.json(
        { error: `Each name must be at most ${MAX_NAME_LENGTH} characters` },
        { status: 400 }
      );
    }
    if (!names.includes(trimmed)) names.push(trimmed);
  }

  if (names.length === 0) {
    logRequest({ ip, route: "/api/games/bulk-lookup", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Provide at least one game name" }, { status: 400 });
  }

  if (names.length > MAX_NAMES) {
    logRequest({ ip, route: "/api/games/bulk-lookup", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: `At most ${MAX_NAMES} names per request` },
      { status: 400 }
    );
  }

  // Look up each name sequentially. A failure on one name never aborts the
  // rest — it just comes back as "not found".
  const results: BulkResult[] = [];
  for (const name of names) {
    let found = false;
    try {
      const result = await lookupGame(name);
      if (result) {
        found = true;
        results.push({
          name,
          found: true,
          title: result.title,
          players: result.players,
          playtimeMinutes: result.playtimeMinutes,
          ageRating: result.ageRating,
          description: result.description,
          tags: result.tags,
          publisherName: result.publisherName,
        });
      } else {
        results.push({ name, found: false });
      }
    } catch (e) {
      console.log(`bulk-lookup: "${name}" failed (${e instanceof Error ? e.message : e})`);
      results.push({ name, found: false });
    }
  }

  logRequest({ ip, route: "/api/games/bulk-lookup", method: "POST", status: 200, durationMs: Date.now() - start });
  return NextResponse.json({ results });
}
