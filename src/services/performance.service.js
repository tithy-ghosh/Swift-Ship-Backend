/**
 * Pure helpers behind GET /api/admin/performance.
 *
 * The controller does the database work; everything that can be reasoned
 * about without a database - bucketing delivery durations and deriving the
 * on-time rate - lives here so it is unit-testable.
 */

/**
 * The service-level target for one delivery: acceptance to door in 24 hours.
 *
 * Cross-district deliveries that route through a godown are a two-leg trip,
 * so a same-day promise would be dishonest for exactly the corridors this
 * page exists to watch. The admin sees the target on the page, and the
 * duration distribution below shows the full shape regardless of it.
 */
export const DELIVERY_SLA_MINUTES = 24 * 60

/**
 * Duration buckets, ascending. `maxMinutes` is exclusive, except where
 * `inclusive` is set: the SLA bucket includes its 24h boundary, so a delivery
 * that lands exactly on the target counts as on time and appears in the
 * "12–24h" row rather than the one after it. The final bucket is open-ended.
 */
export const DELIVERY_DURATION_BUCKETS = [
  { id: 'under-2h', label: '< 2h', maxMinutes: 120 },
  { id: '2h-6h', label: '2–6h', maxMinutes: 360 },
  { id: '6h-12h', label: '6–12h', maxMinutes: 720 },
  { id: '12h-24h', label: '12–24h', maxMinutes: DELIVERY_SLA_MINUTES, inclusive: true },
  { id: 'over-24h', label: '> 24h', maxMinutes: Infinity },
]

/**
 * Distributes delivery durations across the fixed SLA buckets.
 *
 * Invalid entries (NaN, Infinity, negatives) are dropped rather than landing
 * in a bucket, matching `summarizeDurations` in analytics.service.js. Each
 * bucket carries its share of the sample so the UI can render a bar without
 * dividing again, and a zero sample reports a 0% on-time rate rather than
 * dividing by zero.
 *
 * @param {number[]} durations durations in milliseconds
 * @returns {{buckets: Array<{id: string, label: string, count: number, share: number}>,
 *            onTimeRate: number, onTimeMinutes: number, sampleSize: number}}
 */
export const summarizeDeliveryBuckets = (durations = []) => {
  const values = durations
    .map((d) => Number(d))
    .filter((d) => Number.isFinite(d) && d >= 0)

  const sampleSize = values.length
  const counts = new Array(DELIVERY_DURATION_BUCKETS.length).fill(0)
  let onTime = 0

  for (const ms of values) {
    const minutes = ms / 60000

    const index = DELIVERY_DURATION_BUCKETS.findIndex((bucket) =>
      bucket.inclusive ? minutes <= bucket.maxMinutes : minutes < bucket.maxMinutes
    )
    // findIndex cannot miss: the last bucket is Infinity.
    counts[index] += 1

    if (minutes <= DELIVERY_SLA_MINUTES) onTime += 1
  }

  return {
    buckets: DELIVERY_DURATION_BUCKETS.map((bucket, index) => ({
      id: bucket.id,
      label: bucket.label,
      count: counts[index],
      share: sampleSize > 0 ? (counts[index] / sampleSize) * 100 : 0,
    })),
    onTimeRate: sampleSize > 0 ? (onTime / sampleSize) * 100 : 0,
    onTimeMinutes: DELIVERY_SLA_MINUTES,
    sampleSize,
  }
}
