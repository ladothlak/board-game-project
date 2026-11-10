import { NextResponse } from "next/server";
import { getGame } from "@/lib/games";
import { buildRagContext } from "@/lib/rag";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { validateQuestion } from "@/lib/guard";
import { requireAuth } from "@/lib/auth";

/**
 * In-memory prewarm cache. Keyed by slug + normalized question.
 * Entries expire after 60 seconds. Capped at 20 entries.
 */
const prewarmCache = new Map<string, { context: string; toc: string; confidence: number; ts: number }>();
const PREWARM_TTL = 60_000;
const PREWARM_MAX = 20;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of prewarmCache) {
    if (now - entry.ts > PREWARM_TTL) prewarmCache.delete(key);
  }
}, 30_000).unref();

function prewarmKey(slug: string, question: string): string {
  return `${slug}::${question.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/** Exposed so the chat route can check for a pre-warmed context. */
export function getPrewarm(slug: string, question: string) {
  const key = prewarmKey(slug, question);
  const entry = prewarmCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > PREWARM_TTL) {
    prewarmCache.delete(key);
    return null;
  }
  return entry;
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

  const game = await getGame(slug);
  if (!game) {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }

  const apiKey = process.env.UNSLOTH_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ status: "no_key" }, { status: 500 });
  }

  try {
    const rag = await buildRagContext(slug, question.trim(), apiKey);
    const key = prewarmKey(slug, question.trim());

    // Evict oldest if over cap.
    if (prewarmCache.size >= PREWARM_MAX) {
      const oldest = Array.from(prewarmCache.entries()).sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) prewarmCache.delete(oldest[0]);
    }

    prewarmCache.set(key, {
      context: rag.excerpts,
      toc: rag.toc,
      confidence: rag.confidence,
      ts: Date.now(),
    });

    return NextResponse.json({ status: "warmed" }, { status: 200 });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
