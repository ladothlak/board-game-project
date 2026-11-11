import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { startBulkJob } from "@/lib/bulk-add-queue";

/**
 * Start a server-side bulk-add job. Accepts a list of game names, kicks off
 * background processing (lookup → rulebook fetch → create game, paced to stay
 * under external rate limits), and returns a job ID immediately with 202.
 * The client polls /api/games/bulk-add/[jobId] for progress.
 */

const MAX_NAMES = 50;
const MAX_NAME_LENGTH = 200;

export async function POST(req: Request) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const start = Date.now();
  const ip = getClientIp(req);

  // Rate limit: 3 per minute — each job can take many minutes, so be conservative.
  const rate = checkRate(ip, "/api/games/bulk-add", 3, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: "/api/games/bulk-add", method: "POST", status: 429, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Too many bulk add jobs — wait a minute." }, { status: 429 });
  }

  let body: { names?: unknown };
  try {
    body = await req.json();
  } catch {
    logRequest({ ip, route: "/api/games/bulk-add", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body.names;
  if (!Array.isArray(raw)) {
    logRequest({ ip, route: "/api/games/bulk-add", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "`names` must be an array" }, { status: 400 });
  }

  // Normalize + validate each name.
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_NAME_LENGTH) {
      logRequest({ ip, route: "/api/games/bulk-add", method: "POST", status: 400, durationMs: Date.now() - start });
      return NextResponse.json(
        { error: `Each name must be at most ${MAX_NAME_LENGTH} characters` },
        { status: 400 }
      );
    }
    if (!names.includes(trimmed)) names.push(trimmed);
  }

  if (names.length === 0) {
    logRequest({ ip, route: "/api/games/bulk-add", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Provide at least one game name" }, { status: 400 });
  }

  if (names.length > MAX_NAMES) {
    logRequest({ ip, route: "/api/games/bulk-add", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: `At most ${MAX_NAMES} names per request` },
      { status: 400 }
    );
  }

  const jobId = startBulkJob(names);

  logRequest({ ip, route: "/api/games/bulk-add", method: "POST", status: 202, durationMs: Date.now() - start });
  return NextResponse.json({ jobId }, { status: 202 });
}
