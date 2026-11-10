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
