import fs from "fs";
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
function ensureDir() {
  if (ensured) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
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
}

/**
 * Append a single audit entry. Fire-and-forget: never throws, never blocks
 * the request. Safe to call from any route handler.
 */
export function logRequest(entry: Omit<AuditEntry, "ts">) {
  try {
    ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* best-effort — never crash the server for logging */
  }
}
