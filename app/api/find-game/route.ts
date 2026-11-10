import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { listGames, type GameMeta } from "@/lib/games";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { validateQuery } from "@/lib/guard";
import { withQueue } from "@/lib/llm-queue";
import { logRequest } from "@/lib/audit-log";

const UNSLOTH_URL = process.env.UNSLOTH_URL ?? "http://localhost:8888/v1";
const MODEL = process.env.UNSLOTH_MODEL ?? "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";

/**
 * In-memory cache for LLM recommendations. Keyed by normalized query.
 * Capped at 200 entries. The entire cache is invalidated when the game
 * collection changes (a game is added or removed).
 */
const CACHE_MAX = 200;
const cache = new Map<string, { results: unknown[] }>();
let shelfFingerprint = "";

function computeFingerprint(games: GameMeta[]): string {
  // A simple fingerprint: sorted slugs + titles. If any game is added
  // or removed, this changes and we wipe the cache.
  return games.map((g) => `${g.slug}:${g.title}`).sort().join("|");
}

function invalidateIfShelfChanged(games: GameMeta[]): void {
  const fp = computeFingerprint(games);
  if (fp !== shelfFingerprint) {
    cache.clear();
    shelfFingerprint = fp;
  }
}

function getCached(key: string): unknown[] | null {
  const entry = cache.get(key);
  return entry?.results ?? null;
}

function setCached(key: string, results: unknown[]): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { results });
}

function cacheKey(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Stage 1 — Pre-filter: fast keyword/tag matching to narrow the full
 * library to a small shortlist before the LLM sees it. No network call,
 * runs in microseconds even for thousands of games.
 */
function preFilter(games: GameMeta[], query: string): GameMeta[] {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  if (terms.length === 0) return games.slice(0, 6);

  // Also detect structured hints: player count, max minutes.
  const playerMatch = query.match(/(\d+)\s*(?:players?|people)/i);
  const timeMatch = query.match(/(\d+)\s*min/i);
  const playerCount = playerMatch ? Number(playerMatch[1]) : null;
  const maxTime = timeMatch ? Number(timeMatch[1]) : null;

  interface Scored {
    game: GameMeta;
    score: number;
  }

  const scored: Scored[] = games.map((g) => {
    let score = 0;

    const title = g.title.toLowerCase();
    const tags = (g.tags ?? []).map((t) => t.toLowerCase());
    const desc = (g.description ?? "").toLowerCase();

    for (const term of terms) {
      // Title match is strongest signal.
      if (title.includes(term)) score += 5;
      // Tag match is very strong.
      if (tags.some((t) => t.includes(term))) score += 4;
      // Description match is weaker.
      if (desc.includes(term)) score += 1;
    }

    // Structured filters: penalize hard misses.
    if (playerCount != null && g.players) {
      const range = g.players.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (range) {
        if (playerCount < Number(range[1]) || playerCount > Number(range[2])) {
          score -= 6;
        }
      }
    }
    if (maxTime != null && g.playtimeMinutes != null) {
      if (g.playtimeMinutes > maxTime) score -= 4;
    }

    return { game: g, score };
  });

  // Sort by score descending, take top 6. Games with score <= 0 are
  // only included if nothing scored positive (so we always give the
  // LLM *something* to work with).
  scored.sort((a, b) => b.score - a.score);
  const positives = scored.filter((s) => s.score > 0);
  const pool = positives.length > 0 ? positives : scored;
  return pool.slice(0, 6).map((s) => s.game);
}

export async function POST(req: NextRequest) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const start = Date.now();
  const ip = getClientIp(req);

  // Rate limit: 5 requests per minute per IP.
  const rate = checkRate(ip, "/api/find-game", 5, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: "/api/find-game", method: "POST", status: 429, durationMs: Date.now() - start });
    const res = NextResponse.json({ error: "Too many requests — slow down." }, { status: 429 });
    res.headers.set("Retry-After", String(rate.retryAfter));
    return res;
  }

  let body: { query?: string };
  try {
    body = await req.json();
  } catch {
    logRequest({ ip, route: "/api/find-game", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const query = body.query?.trim() ?? "";
  if (!query) {
    logRequest({ ip, route: "/api/find-game", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "No query provided." }, { status: 400 });
  }

  // Input validation + prompt-injection guard.
  const guard = validateQuery(query);
  if (!guard.ok) {
    logRequest({ ip, route: "/api/find-game", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: guard.reason }, { status: 400 });
  }

  const games = await listGames();
  if (games.length === 0) {
    return NextResponse.json({ recommendations: [] });
  }

  // Invalidate cache if the shelf changed since last request.
  invalidateIfShelfChanged(games);

  // Check cache first — skip the LLM entirely for repeat queries.
  const key = cacheKey(query);
  const cached = getCached(key);
  if (cached) {
    return NextResponse.json({ recommendations: cached, cached: true });
  }

  // Stage 1: narrow to a shortlist.
  const candidates = preFilter(games, query);

  // Build a compact catalog from just the candidates.
  const catalog = candidates
    .map(
      (g) =>
        `- ${g.title}: ${g.description ?? ""} [tags: ${(g.tags ?? []).join(", ")}] [players: ${g.players ?? "?"}] [time: ${g.playtimeMinutes != null ? `~${g.playtimeMinutes} min` : "?"}]`
    )
    .join("\n");

  const system = `You are a helpful board game consultant at a cozy coffee shop. The customer describes what kind of game they're in the mood for, and you recommend games from the shortlist below. Be generous — partial matches are fine. A game that fits most of the criteria is still a good recommendation.

Here is the shortlist:
${catalog}

Respond with a JSON array of recommended games. Each entry must have:
- "slug": the exact slug from the shortlist
- "reason": one short sentence explaining why it fits their request

Include at most 3 recommendations, ordered best-first. Prefer to recommend at least one game if any partially fit. Only return an empty array if truly nothing is relevant. Respond with ONLY the JSON array — no prose, no markdown fences.`;

  try {
    // Single-flight queue + 45s timeout.
    const res = await withQueue(() =>
      fetch(`${UNSLOTH_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: system },
            { role: "user", content: query },
          ],
          temperature: 0.3,
          max_tokens: 2000,
        }),
        signal: AbortSignal.timeout(45_000),
      })
    );

    if (!res.ok) {
      logRequest({ ip, route: "/api/find-game", method: "POST", status: 502, durationMs: Date.now() - start });
      return NextResponse.json(
        { error: "LLM provider unavailable" },
        { status: 502 }
      );
    }

    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? "";

    // Extract the JSON array from the response.
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return NextResponse.json({ recommendations: [] });
    }

    let parsed: Array<{ slug: string; reason: string }>;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return NextResponse.json({ recommendations: [] });
    }

    // Only include slugs that actually exist on the shelf. The LLM
    // sometimes returns the title instead of the slug, so we normalize
    // and also try matching against titles.
    const valid = new Set(games.map((g) => g.slug));
    const titleToSlug = new Map(games.map((g) => [g.title.toLowerCase(), g.slug]));

    function resolveSlug(raw: string): string | null {
      if (valid.has(raw)) return raw;
      // Normalize: lowercase, spaces → hyphens.
      const normalized = raw.toLowerCase().replace(/\s+/g, "-");
      if (valid.has(normalized)) return normalized;
      // Try matching against a game title.
      const byTitle = titleToSlug.get(raw.toLowerCase());
      if (byTitle) return byTitle;
      return null;
    }

    let recommendations: Array<{
      slug: string;
      title: string;
      reason: string;
      tags: string[];
      players?: string;
      playtimeMinutes?: number;
    }> = [];

    for (const r of parsed.slice(0, 3)) {
      const slug = resolveSlug(r.slug);
      if (!slug) continue;
      const game = games.find((g) => g.slug === slug);
      recommendations.push({
        slug,
        title: game?.title ?? r.slug,
        reason: r.reason,
        tags: game?.tags ?? [],
        players: game?.players,
        playtimeMinutes: game?.playtimeMinutes,
      });
    }

    // Fallback: if the LLM returned nothing, serve the pre-filter's
    // top picks directly so the user always gets *something*.
    if (recommendations.length === 0 && candidates.length > 0) {
      recommendations = candidates.slice(0, 3).map((g) => ({
        slug: g.slug,
        title: g.title,
        reason: "Matched your criteria.",
        tags: g.tags ?? [],
        players: g.players,
        playtimeMinutes: g.playtimeMinutes,
      }));
    }

    // Store in cache for future identical queries.
    setCached(key, recommendations);

    logRequest({ ip, route: "/api/find-game", method: "POST", status: 200, durationMs: Date.now() - start });
    return NextResponse.json({ recommendations });
  } catch {
    logRequest({ ip, route: "/api/find-game", method: "POST", status: 502, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: "Could not reach the LLM." },
      { status: 502 }
    );
  }
}
