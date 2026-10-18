/**
 * Fixed-window in-memory rate limiter. Counters are per process; with several
 * instances each instance enforces its own window.
 */
export function createRateLimiter({ name, windowMs, max, keyFn, clock, sendError }) {
  const buckets = new Map();
  let nextPruneAt = 0;

  function prune(now) {
    if (now < nextPruneAt) return;
    nextPruneAt = now + windowMs;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return function rateLimit(req, res, next) {
    const key = keyFn(req);
    if (!key) return next();

    const now = clock.now();
    prune(now);

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      return sendError(res, 429, 'RATE_LIMITED', 'Too many requests. Please try again later.', {
        limiter: name,
        retryAfterSeconds,
      });
    }

    return next();
  };
}
