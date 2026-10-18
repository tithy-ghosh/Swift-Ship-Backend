/**
 * Small in-memory rate limiter for expensive merchant endpoints.
 *
 * Deliberately dependency-free and process-local: this server runs as a single
 * node process today, and the goal is to stop a merchant (or a broken script)
 * from hammering the bulk-upload endpoints, not to be a bastion against a
 * distributed attack. A restart clears the counters, which is the right
 * trade-off at this scale.
 *
 * Keyed by Firebase uid when the request is authenticated (these routes always
 * are, behind `verifyToken`), falling back to the IP for anything else.
 *
 * @param {{windowMs?: number, max?: number, now?: () => number}} [options]
 * @returns {import('express').RequestHandler}
 */
export const createRateLimiter = ({ windowMs = 60_000, max = 30, now = Date.now } = {}) => {
  /** @type {Map<string, number[]>} recent hit timestamps per key */
  const hits = new Map()

  return (req, res, next) => {
    const key = req.user?.uid || req.ip || 'anonymous'
    const current = now()
    const recent = (hits.get(key) || []).filter((timestamp) => current - timestamp < windowMs)

    if (recent.length >= max) {
      return res.status(429).json({
        error: 'Too many requests. Wait a moment and try again.',
      })
    }

    recent.push(current)
    hits.set(key, recent)

    return next()
  }
}
