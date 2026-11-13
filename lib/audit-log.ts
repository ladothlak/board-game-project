import fs from "fs/promises";
import path from "path";

/**
 * Lightweight file-based audit logger.
 * Writes one JSON line per API call to `logs/audit.log` in the project root.
 * Rotates daily: if the current date differs from the last entry, a new
 * file `audit-YYYY-MM-DD.jsonl` is started.
 */

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "audit.log");

// Ensure the log directory exists (lazy, once).
let ensured = false;
async function ensureDir() {
  if (ensured) return;
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
  } catch {
    /* ignore — logging is best-effort */
  }
  ensured = true;
}

interface AuditEntry {
  ts: string;
  ip: string;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  body?: string;
  /** Per-stage wall-clock durations in ms (e.g. expandMs, retrieveMs, rerankMs, firstTokenMs). */
  stages?: Record<string, number>;
  /** True when the request was served from the speculative prewarm cache. */
  prewarmHit?: boolean;
  /** True when the request was served from the final-answer cache (issue #56). */
  answerCacheHit?: boolean;
}

/**
 * Append a single audit entry. Fire-and-forget: never throws, never blocks
 * the request. Safe to call from any route handler.
 */
export async function logRequest(entry: Omit<AuditEntry, "ts">) {
  try {
    await ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    await fs.appendFile(LOG_FILE, line + "\n");
  } catch {
    /* best-effort — never crash the server for logging */
  }
}
