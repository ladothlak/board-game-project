import fs from "fs/promises";
import path from "path";
import { revalidateTag } from "next/cache";

export interface Suggestion {
  field: "players" | "playtimeMinutes" | "ageRating";
  current: string | number;
  suggested: string | number;
  note: string;
}

export interface Expansion {
  name: string;
  pdf: string;
  // When true, the expansion's rulebook is indexed into the game's chat context.
  inChatContext?: boolean;
}

export interface PairSuggestion {
  slug: string;
  reason: string;
}

export interface GameMeta {
  slug: string;
  title: string;
  description: string;
  image?: string;
  pdf?: string;
  players?: string;
  playtimeMinutes?: number;
  ageRating?: string;
  tags?: string[];
  suggestions?: Suggestion[];
  // A 1–5 complexity score, LLM-estimated and stored in meta.json.
  complexity?: number;
  // A 1–5 personal rating, stored separately in rating.json.
  rating?: number;
  // When true, the game is kept on disk (rulebook, notes, metadata all
  // intact) but taken off the shelf and out of search. Reversible.
  hidden?: boolean;
  // Expansions attached to this game (each has its own rulebook PDF).
  expansions?: Expansion[];
  // LLM-generated "pairs well with" suggestions (complementary games).
  pairsWith?: PairSuggestion[];
  // Shelf fingerprint ("slug:title" pairs, sorted, joined with "|") at the
  // time pairsWith was generated. Used to detect when the shelf changed
  // and the cached pairs need regenerating.
  pairsFingerprint?: string;
}

const gamesDir = path.join(process.cwd(), "content", "games");

// ─── In-memory TTL cache ───────────────────────────────────────────────
// Avoids redundant disk reads on every request. Invalidated on write.
let _cache: GameMeta[] | null = null;
let _cacheTime = 0;
const CACHE_TTL = 30_000; // 30 seconds

export function invalidateGamesCache(): void {
  _cache = null;
  _cacheTime = 0;
  // Also invalidate Next's data cache so cached pages re-render on the next
  // request. No-op outside a request context (e.g. build time, queue worker).
  try {
    revalidateTag("games");
  } catch {
    /* not in a request scope */
  }
}

async function readAllGames(): Promise<GameMeta[]> {
  let slugs: string[] = [];
  try {
    slugs = (await fs.readdir(gamesDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // no games directory yet
  }

  const games: GameMeta[] = [];
  for (const slug of slugs) {
    const metaPath = path.join(gamesDir, slug, "meta.json");
    let meta: any;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    } catch (e) {
      console.error(`Failed to read ${metaPath}:`, e);
      continue;
    }
    // Attach the personal rating if one exists (stored in rating.json).
    const ratingPath = path.join(gamesDir, slug, "rating.json");
    try {
      const r = JSON.parse(await fs.readFile(ratingPath, "utf8"));
      if (Number.isFinite(r.stars)) meta.rating = r.stars;
    } catch {
      /* ignore malformed rating */
    }
    games.push({ slug, ...meta });
  }
  return games;
}

export async function listGames(): Promise<GameMeta[]> {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) {
    return _cache.filter((g) => !g.hidden).sort((a, b) => a.title.localeCompare(b.title));
  }
  const all = await readAllGames();
  _cache = all;
  _cacheTime = now;
  return all.filter((g) => !g.hidden).sort((a, b) => a.title.localeCompare(b.title));
}

/** The games currently hidden from the shelf (data intact on disk). */
export async function listHiddenGames(): Promise<GameMeta[]> {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) {
    return _cache.filter((g) => g.hidden).sort((a, b) => a.title.localeCompare(b.title));
  }
  const all = await readAllGames();
  _cache = all;
  _cacheTime = now;
  return all.filter((g) => g.hidden).sort((a, b) => a.title.localeCompare(b.title));
}

export async function getGame(slug: string): Promise<GameMeta | null> {
  // Guard against path traversal via the slug.
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) {
    return _cache.find((g) => g.slug === slug) ?? null;
  }
  const all = await readAllGames();
  _cache = all;
  _cacheTime = now;
  return all.find((g) => g.slug === slug) ?? null;
}
