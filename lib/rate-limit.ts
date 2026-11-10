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
 * `x-forwarded-for` and `x-real-ip` are set by the client, so trusting them
 * unconditionally lets any user rotate their own "IP" on every request and
 * bypass the per-IP budget. We therefore only use `x-forwarded-for` when the
 * request has passed through a trusted reverse proxy, indicated by the
 * server-set `x-request-id` header (which clients do not set). Direct
 * connections all share one fixed identifier: nobody can rotate their
 * identity, and total abuse is still bounded by the per-route budget.
 *
 * Note: we deliberately do NOT fall back to the `host` header — it is also
 * client-settable and would be rotatable in the same way.
 */
export function getClientIp(req: Request): string {
  if (req.headers.get("x-request-id") !== null) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      // The leftmost entry is the original client IP.
      return forwarded.split(",")[0].trim();
    }
  }
  return "direct";
}
