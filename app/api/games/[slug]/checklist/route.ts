import { NextResponse } from "next/server";
import { getGame } from "@/lib/games";
import { readChecklist, writeChecklist, generateChecklist } from "@/lib/generate-checklist";

/**
 * GET — return the stored setup checklist, or { steps: null } if none yet.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!getGame(slug)) {
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }
  const checklist = readChecklist(slug);
  return NextResponse.json(checklist ? { steps: checklist.steps } : { steps: null });
}

/**
 * POST — generate the setup checklist from the rulebook and persist it.
 * Skips regeneration when one already exists, unless { force: true }.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!getGame(slug)) {
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }

  let force = false;
  try {
    const body = await req.json();
    force = Boolean(body?.force);
  } catch {
    /* no body is fine — defaults to non-forced */
  }

  const existing = readChecklist(slug);
  if (existing && !force) {
    return NextResponse.json({ steps: existing.steps });
  }

  const checklist = await generateChecklist(slug);
  if (!checklist) {
    return NextResponse.json(
      { error: "Could not generate a setup checklist from the rulebook." },
      { status: 502 }
    );
  }

  writeChecklist(slug, checklist);
  return NextResponse.json({ steps: checklist.steps });
}
