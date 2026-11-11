/**
 * Server-side bulk-add job queue.
 *
 * Replaces the old client-side sequential "add selected" flow: the client
 * POSTs a list of game names to /api/games/bulk-add, which starts a job here
 * and returns a job ID immediately. The job then processes each game in the
 * background — lookup, rulebook fetch (paced at one per ~13 seconds so we
 * stay under the external rate limits), download, game creation, digest —
 * while the client polls /api/games/bulk-add/[jobId] for progress.
 *
 * Jobs live in memory. For a self-hosted single-user app that's fine; done
 * jobs are pruned after an hour so the map can't grow unbounded.
 */

import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { lookupGame, type LookupResult } from "@/lib/lookup";
import { findRulebookPdf, downloadRulebookPdf } from "@/lib/fetch-rulebook-core";
import { listGames, listHiddenGames, invalidateGamesCache } from "@/lib/games";
import { digestRulebook } from "@/lib/digest-rulebook.mjs";
import { renderCoverFromPdf } from "@/lib/render-cover.mjs";

export type BulkGameStatus = "pending" | "working" | "added" | "duplicate" | "no_rulebook" | "error";

export interface BulkGameResult {
  name: string;
  status: BulkGameStatus;
  error?: string;
}

export interface BulkJob {
  id: string;
  status: "processing" | "done";
  total: number;
  results: BulkGameResult[];
  // When true, games without a rulebook are shelved anyway (no PDF).
  includeNoRulebook: boolean;
}

const jobs = new Map<string, BulkJob>();
// Creation timestamps, kept separately so the public job shape stays stable.
const jobStartTimes = new Map<string, number>();
const DONE_JOB_TTL_MS = 60 * 60 * 1000; // prune done jobs after an hour

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prune finished jobs older than the TTL. Called on every new job. */
function pruneOldJobs(): void {
  const now = Date.now();
  for (const [id, started] of jobStartTimes) {
    const job = jobs.get(id);
    if (job?.status === "done" && now - started > DONE_JOB_TTL_MS) {
      jobs.delete(id);
      jobStartTimes.delete(id);
    }
  }
}

/**
 * Create a bulk-add job and kick off its background processing. Returns the
 * job ID immediately — the work continues after this resolves.
 *
 * When `includeNoRulebook` is true, games whose rulebook can't be found are
 * still shelved (without a PDF) instead of being skipped.
 */
export function startBulkJob(names: string[], includeNoRulebook = false): string {
  pruneOldJobs();

  const id = randomUUID();
  const job: BulkJob = {
    id,
    status: "processing",
    total: names.length,
    results: names.map((name) => ({ name, status: "pending" as const })),
    includeNoRulebook,
  };
  jobs.set(id, job);
  jobStartTimes.set(id, Date.now());

  // Fire-and-forget: the request that started this job is long gone by the
  // time the first rulebook fetch finishes.
  processJob(job).catch((e) => {
    console.error(`bulk-add job ${id} crashed:`, e);
    // Defensive: settle any items still in-flight so the client doesn't
    // show spinners forever.
    for (const r of job.results) {
      if (r.status === "pending" || r.status === "working") {
        r.status = "error";
        r.error = "Job crashed";
      }
    }
    job.status = "done";
  });

  return id;
}

/** Read a job's current state for the polling endpoint. */
export function getJob(jobId: string): BulkJob | undefined {
  return jobs.get(jobId);
}

// ─── Background processing ──────────────────────────────────────────────────

async function processJob(job: BulkJob): Promise<void> {
  for (let i = 0; i < job.results.length; i++) {
    const result = job.results[i];
    result.status = "working";
    result.error = undefined;

    try {
      // 1. Look up metadata (BGG → Wikipedia → web).
      const meta = await lookupGame(result.name);
      if (!meta) {
        if (job.includeNoRulebook) {
          // Shelf it with just the name — no metadata, no rulebook.
          await createGameWithoutPdf(result.name, null);
          result.status = "added";
        } else {
          result.status = "no_rulebook";
          result.error = "Not found";
        }
        continue;
      }

      // Duplicate check: if a game with this slug is already on the shelf,
      // skip it rather than creating a suffixed duplicate (e.g. "catan-2").
      // Checked before the rulebook download to avoid wasting a rate-limited
      // fetch on a game we're not going to add.
      const baseSlug = slugify(result.name);
      if (baseSlug && (await listGames()).some((g) => g.slug === baseSlug)) {
        result.status = "duplicate";
        continue;
      }

      // 2. Find the rulebook PDF via the shared search routine.
      const found = await findRulebookPdf(result.name, {
        publisherName: meta.publisherName,
        isExpansion: false,
      });
      if (!found) {
        if (job.includeNoRulebook) {
          // Shelf it anyway, without a rulebook — no PDF to digest.
          await createGameWithoutPdf(result.name, meta);
          result.status = "added";
        } else {
          result.status = "no_rulebook";
        }
        continue;
      }

      // 3. Download the PDF and create the game.
      const bytes = await downloadRulebookPdf(found.url);
      await createGame(result.name, meta, bytes);
      result.status = "added";
    } catch (e) {
      result.status = "error";
      result.error = e instanceof Error ? e.message : "Unknown error";
    }

    // Pacing: the fetch-rulebook pipeline is rate-limited to 5/minute on the
    // external side. Sleeping ~13s between games keeps us comfortably under
    // that without any client-side retry logic.
    if (i < job.results.length - 1) {
      await sleep(13_000);
    }
  }

  job.status = "done";
}

// ─── Game creation (mirrors POST /api/games) ─────────────────────────────────

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function createGame(name: string, meta: LookupResult, pdfBytes: Buffer): Promise<void> {
  const baseSlug = slugify(name);
  if (!baseSlug) {
    throw new Error("Title could not be converted to a slug");
  }
  const taken = new Set([
    ...(await listGames()).map((g) => g.slug),
    ...(await listHiddenGames()).map((g) => g.slug),
  ]);
  let slug = baseSlug;
  let n = 2;
  while (taken.has(slug)) slug = `${baseSlug}-${n++}`;

  const dir = path.join(process.cwd(), "content", "games", slug);
  await fs.mkdir(dir, { recursive: true });

  // Save the rulebook and render a cover from page 1 of the PDF.
  const pdfPath = path.join(dir, "rules.pdf");
  await fs.writeFile(pdfPath, pdfBytes);

  let hasCover = false;
  try {
    await renderCoverFromPdf(pdfPath, path.join(dir, "cover.jpg"));
    hasCover = true;
  } catch (e) {
    console.warn(`bulk-add: cover render failed for ${slug}:`, e instanceof Error ? e.message : e);
    // Non-fatal — the game works without a cover.
  }

  const gameMeta = {
    title: name,
    description: "", // filled in by the async digest job
    image: hasCover ? "cover.jpg" : undefined,
    pdf: "rules.pdf",
    players: meta.players,
    playtimeMinutes: meta.playtimeMinutes,
    ageRating: meta.ageRating,
    tags: (meta.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
  };
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(gameMeta, null, 2));
  invalidateGamesCache();

  // Fire-and-forget: digest the rulebook (search index + LLM description).
  void digestRulebook(slug).catch((e) =>
    console.error(`bulk-add: digest ${slug} failed:`, e instanceof Error ? e.message : e)
  );
}

/**
 * Create a game without a rulebook PDF (used when the caller opted in to
 * shelve games even if no rulebook was found). Writes meta.json with the
 * looked-up metadata but NO pdf field and an empty description — no cover is
 * rendered and no digest is fired, since there's nothing to read from.
 */
async function createGameWithoutPdf(name: string, meta: LookupResult | null): Promise<void> {
  const baseSlug = slugify(name);
  if (!baseSlug) {
    throw new Error("Title could not be converted to a slug");
  }
  const taken = new Set([
    ...(await listGames()).map((g) => g.slug),
    ...(await listHiddenGames()).map((g) => g.slug),
  ]);
  let slug = baseSlug;
  let n = 2;
  while (taken.has(slug)) slug = `${baseSlug}-${n++}`;

  const dir = path.join(process.cwd(), "content", "games", slug);
  await fs.mkdir(dir, { recursive: true });

  const gameMeta = {
    title: name,
    description: "", // no rulebook to digest — filled in later if one is added
    players: meta?.players,
    playtimeMinutes: meta?.playtimeMinutes,
    ageRating: meta?.ageRating,
    tags: (meta?.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
  };
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(gameMeta, null, 2));
  invalidateGamesCache();
}
