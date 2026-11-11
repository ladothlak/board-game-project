import { NextResponse } from "next/server";
import { getJob } from "@/lib/bulk-add-queue";

/**
 * Poll the state of a bulk-add job. Read-only status check, so no auth is
 * required — it only exposes per-game progress for jobs started by this
 * server's own (authenticated) users. Jobs live in memory; that's fine for a
 * self-hosted single-user app.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await ctx.params;
  const job = getJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Unknown job" }, { status: 404 });
  }

  return NextResponse.json({
    status: job.status,
    total: job.total,
    results: job.results,
  });
}
