import { NextResponse } from "next/server";
import { getGame } from "@/lib/games";
import { buildPrewarmHeadStart, type PrewarmHeadStart } from "@/lib/rag";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { validateQuestion } from "@/lib/guard";
import { requireAuth } from "@/lib/auth";

/**
 * The quality of a cached prewarm payload (issue #67):
 * - "fast": a deterministic HEAD START only (index load, DF, base retrieval,
 *   keyword classification). NOT a final-answer-ready context — the chat
 *   route finishes the quality stages (re-rank + assembly) over it in
 *   /api/chat before returning. Never served as a final answer.
 * - "full": a final-answer-ready RagContext that may be served directly.
 *   Reserved for future background prewarm of the full pipeline; the fast
 *   path never produces this today.
 */
export type PrewarmQuality = "fast" | "full";

/** A cached prewarm payload: a head start plus its quality flag. */
export interface PrewarmEntry {
  headStart: PrewarmHeadStart;
  quality: PrewarmQuality;
  ts: number;
}

/**
 * In-memory prewarm cache. Keyed by slug + normalized question.
 * Entries expire after 60 seconds. Capped at 20 entries.
 *
 * Stores only deterministic HEAD STARTS (quality "fast") — never a
 * final-answer-ready context built with `skipRerank` (issue #67). The chat
 * route uses each entry as a head start and finishes the full pipeline over
 * it, so a prewarm hit and a cold request produce identical excerpts.
 */
const prewarmCache = new Map<string, PrewarmEntry>();
const PREWARM_TTL = 60_000;
const PREWARM_MAX = 20;

/**
 * In-flight prewarm builds keyed by slug + normalized question (issue #60).
 * A second prewarm for the same question — or a real /api/chat request —
 * awaits the existing promise instead of starting a second head-start build.
 */
const inflightPrewarms = new Map<string, Promise<PrewarmHeadStart>>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of prewarmCache) {
    if (now - entry.ts > PREWARM_TTL) prewarmCache.delete(key);
  }
}, 30_000).unref();

function prewarmKey(slug: string, question: string): string {
  return `${slug}::${question.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/** Exposed so the chat route can check for a pre-warmed head start. */
export function getPrewarm(slug: string, question: string): PrewarmEntry | null {
  const key = prewarmKey(slug, question);
  const entry = prewarmCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > PREWARM_TTL) {
    prewarmCache.delete(key);
    return null;
  }
  return entry;
}

/**
 * Exposed so the chat route can await an in-flight prewarm build for a
 * question (issue #60) instead of building a second head start. Returns null
 * when no build is currently in flight for that key.
 */
export function getInflightPrewarm(slug: string, question: string): Promise<PrewarmHeadStart> | null {
  return inflightPrewarms.get(prewarmKey(slug, question)) ?? null;
}

/** Test helper: clear both module-level maps so tests start cold. */
export function resetPrewarmStateForTest(): void {
  prewarmCache.clear();
  inflightPrewarms.clear();
}

export async function POST(req: Request) {
  const denied = requireAuth(req as any);
  if (denied) return denied;
  const ip = getClientIp(req);

  // Rate limit prewarm requests more aggressively (they're speculative).
  const rate = checkRate(ip, "/api/chat/prewarm", 15, 60_000);
  if (!rate.allowed) {
    return NextResponse.json({ status: "throttled" }, { status: 200 });
  }

  let body: { slug?: string; question?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ status: "error" }, { status: 400 });
  }

  const { slug, question } = body;
  if (!slug || !question?.trim() || question.trim().length < 15) {
    return NextResponse.json({ status: "too_short" }, { status: 200 });
  }

  const guard = validateQuestion(question.trim());
  if (!guard.ok) {
    return NextResponse.json({ status: "blocked" }, { status: 200 });
  }

  // Deduplication (issue #60): register the in-flight build synchronously in
  // the handler's first tick — before any await — so two concurrent prewarms
  // for the same question can't interleave through an await window and start
  // a second head-start build. If a build for this exact question is already
  // in flight, await it instead of starting one.
  const q = question.trim();
  const key = prewarmKey(slug, q);
  let inflight = inflightPrewarms.get(key);
  if (!inflight) {
    // Head start only (issue #67): the deterministic prefix — index load, DF
    // table, base retrieval, keyword classification — zero model calls. It is
    // NOT a final-answer-ready context: the chat route finishes the quality
    // stages (re-rank + assembly) over it in /api/chat. Marked "fast" so a
    // prewarm hit is never served as a final answer. This keeps the endpoint's
    // latency benefit — it still saves the real prefix work — without storing
    // a `skipRerank` context.
    inflight = buildPrewarmHeadStart(slug, q).then((headStart) => {
      // Evict oldest if over cap.
      if (prewarmCache.size >= PREWARM_MAX) {
        const oldest = Array.from(prewarmCache.entries()).sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) prewarmCache.delete(oldest[0]);
      }

      prewarmCache.set(key, {
        headStart,
        quality: "fast",
        ts: Date.now(),
      });
      return headStart;
    }).finally(() => {
      // Drop the in-flight entry once settled (success or failure) so a
      // later request starts a fresh build instead of awaiting a dead one.
      inflightPrewarms.delete(key);
    });
    inflightPrewarms.set(key, inflight);
  }

  const game = await getGame(slug);
  if (!game) {
    // Abandon the registered promise (harmless — the head start makes no
    // model calls). The map entry is cleaned up by .finally() once the
    // in-flight build settles.
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }

  try {
    await inflight;
    return NextResponse.json({ status: "warmed" }, { status: 200 });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
