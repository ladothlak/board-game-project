/**
 * In-memory sliding-window rate limiter.
 * Keyed by IP + route so each endpoint gets its own budget.
 * No external deps — suitable for a single-process self-hosted server.
 */

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

/** Periodic cleanup to prevent unbounded memory growth. */
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    b.timestamps = b.timestamps.filter((t) => now - t < 60_000);
    if (b.timestamps.length === 0) buckets.delete(key);
  }
}, 60_000).unref();

/**
 * Check whether a request from `ip` on `route` is within the allowed rate.
 * @param limit  max requests per window
 * @param windowMs  window size in milliseconds
 * @returns `{ allowed: true }` or `{ allowed: false, retryAfter: seconds }`
 */
export function checkRate(ip: string, route: string, limit: number, windowMs: number) {
  const key = `${ip}:${route}`;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }
  // Evict entries outside the window.
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0];
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
    return { allowed: false as const, retryAfter };
  }

  bucket.timestamps.push(now);
  return { allowed: true as const };
}

/**
 * Determine a trustworthy client identifier for rate limiting.
 *
 * Every request header that could identify a client — `x-forwarded-for`,
 * `x-real-ip`, `host` — is set by the client, so reading any of them lets an
 * attacker rotate their own "IP" on every request and get a fresh per-IP
 * bucket each time, bypassing the budget. A previous revision tried to detect
 * a trusted reverse proxy via the `x-request-id` header, but that header is
 * ALSO client-settable, so it was spoofable in exactly the same way.
 *
 * This deployment is self-hosted with NO reverse proxy in front of the app,
 * so there is no trustworthy server-set signal to key on at all. We therefore
 * return a single fixed identifier for every request: nobody can rotate their
 * identity, and total abuse is bounded by the per-route budget. It is
 * unspoofable by construction because it reads no headers whatsoever.
 *
 * If a reverse proxy is added in the future, this can be revisited (e.g., an
 * env-var gate where the proxy strips client-set headers before forwarding).
 */
export function getClientIp(_req: Request): string {
  return "direct";
}
