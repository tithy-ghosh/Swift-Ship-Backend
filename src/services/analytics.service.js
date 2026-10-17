import { BUSINESS_TIMEZONE, startOfDay, startOfWeek } from '../utils/dates.js'

export { BUSINESS_TIMEZONE }

/** Milliseconds in one day. Asia/Dhaka has no DST, so fixed steps are exact. */
export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Normalises a range query value to a number of days.
 *
 * An unknown or missing range falls back to 30 days rather than throwing, so a
 * hand-edited query string cannot 500 the admin dashboard.
 *
 * @param {'7d'|'30d'|'90d'|string} [range]
 * @returns {7|30|90}
 */
export const normalizeRangeDays = (range) => (range === '7d' ? 7 : range === '90d' ? 90 : 30)

/**
 * Normalises a granularity query value.
 *
 * @param {'day'|'week'|string} [granularity]
 * @returns {'day'|'week'}
 */
export const normalizeGranularity = (granularity) => (granularity === 'week' ? 'week' : 'day')

/**
 * Resolves the current and previous analytics windows.
 *
 * The current window is `days` Dhaka-local days ending today, so it always
 * includes today's partial data - admins expect "revenue today" to move during
 * the day. The previous window is the equally long block of days immediately
 * before it, which is what makes an apples-to-apples delta possible.
 *
 * Both windows are half-open `[start, end)`: a payment at exactly midnight
 * belongs to the new day, never to both.
 *
 * @param {'7d'|'30d'|'90d'} range
 * @param {Date} [reference] "now" - injectable for deterministic tests.
 */
export const resolveWindow = (range, reference = new Date()) => {
  const days = normalizeRangeDays(range)

  // Midnight Dhaka today. The window's last bucket is today, so it starts
  // `days - 1` days earlier.
  const todayStart = startOfDay(reference)
  const start = new Date(todayStart.getTime() - (days - 1) * DAY_MS)
  const end = reference

  return {
    days,
    start,
    end,
    prevStart: new Date(start.getTime() - days * DAY_MS),
    prevEnd: start,
  }
}

/**
 * Percentage change of `current` over `previous`.
 *
 * Returns `null` when there is no baseline to grow from (previous is 0 but
 * current is not) so the UI can render "—" instead of a misleading +Infinity.
 * Two zeroes are a genuine no-change, which is 0%.
 *
 * @returns {number|null}
 */
export const percentChange = (current, previous) => {
  const cur = Number(current) || 0
  const prev = Number(previous) || 0

  if (prev === 0) return cur === 0 ? 0 : null

  return ((cur - prev) / Math.abs(prev)) * 100
}

/**
 * Difference between two rates, in percentage points.
 *
 * 40% -> 45% is +5 points, not +12.5%: mixing the two kinds of comparison on a
 * rate is the classic analytics lie.
 */
export const pointChange = (current, previous) => (Number(current) || 0) - (Number(previous) || 0)

/**
 * Average, median and 90th-percentile of a list of durations, in minutes.
 *
 * Median and p90 are computed here rather than in the database so the endpoint
 * does not depend on MongoDB 7's `$percentile`. The list is bounded by the
 * number of deliveries in the window, which is small enough to sort in memory.
 *
 * Invalid entries (NaN, Infinity, negatives) are dropped rather than skewing
 * the figures; an empty list is all zeroes with a sample size of 0.
 *
 * @param {number[]} durations durations in milliseconds
 */
export const summarizeDurations = (durations = []) => {
  const values = durations
    .map((d) => Number(d))
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b)

  const sampleSize = values.length
  if (sampleSize === 0) {
    return { avgMinutes: 0, medianMinutes: 0, p90Minutes: 0, sampleSize: 0 }
  }

  const sum = values.reduce((total, value) => total + value, 0)
  const avgMs = sum / sampleSize

  const middle = Math.floor(sampleSize / 2)
  const medianMs =
    sampleSize % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle]

  // Nearest-rank percentile: the smallest value at or above the 90th centile.
  const rankIndex = Math.min(Math.ceil(0.9 * sampleSize) - 1, sampleSize - 1)
  const p90Ms = values[Math.max(rankIndex, 0)]

  const toMinutes = (ms) => Math.round((ms / 60000) * 10) / 10

  return {
    avgMinutes: toMinutes(avgMs),
    medianMinutes: toMinutes(medianMs),
    p90Minutes: toMinutes(p90Ms),
    sampleSize,
  }
}

/**
 * The instants at which each day-bucket starts, oldest first, ending today.
 *
 * @returns {Date[]}
 */
export const dayBucketStarts = (days, reference = new Date(), timeZone = BUSINESS_TIMEZONE) => {
  const todayStart = startOfDay(reference, timeZone)

  return Array.from(
    { length: days },
    (_, index) => new Date(todayStart.getTime() - (days - 1 - index) * DAY_MS)
  )
}

/**
 * The instants at which each week-bucket starts, oldest first.
 *
 * Weeks follow the business calendar (Saturday start), and the span covers the
 * window the range asks for: the first bucket is the Saturday on or before the
 * window's first day, the last is the Saturday on or before today. A 30-day
 * window therefore yields roughly five points instead of thirty.
 *
 * @returns {Date[]}
 */
export const weekBucketStarts = (days, reference = new Date(), timeZone = BUSINESS_TIMEZONE) => {
  const firstDay = new Date(startOfDay(reference, timeZone).getTime() - (days - 1) * DAY_MS)
  const firstWeek = startOfWeek(firstDay, timeZone)
  const lastWeek = startOfWeek(reference, timeZone)

  const starts = []
  for (let time = firstWeek.getTime(); time <= lastWeek.getTime(); time += 7 * DAY_MS) {
    starts.push(new Date(time))
  }

  return starts
}

/**
 * The bucket-start instants for a range at the requested granularity.
 *
 * @returns {Date[]}
 */
export const bucketStarts = (
  days,
  granularity = 'day',
  reference = new Date(),
  timeZone = BUSINESS_TIMEZONE
) =>
  granularity === 'week'
    ? weekBucketStarts(days, reference, timeZone)
    : dayBucketStarts(days, reference, timeZone)

/**
 * A Mongo `$group._id` expression that labels each document with the Dhaka
 * calendar date of its bucket, as `YYYY-MM-DD`.
 *
 * The same date string is what `buildSeries` regenerates in JS, which is what
 * lets the two halves agree without sharing a timezone library.
 *
 * For weekly buckets the document's date is first truncated to the start of its
 * Saturday week; the formatted date is then that week start.
 *
 * @param {string} field a `$`-prefixed date field, e.g. `'$eventTime'`
 */
export const dateGroupExpression = (field, granularity = 'day', timeZone = BUSINESS_TIMEZONE) => {
  const date =
    granularity === 'week'
      ? { $dateTrunc: { date: field, unit: 'week', timezone: timeZone, startOfWeek: 'saturday' } }
      : field

  return { $dateToString: { format: '%Y-%m-%d', date, timezone: timeZone } }
}

/** Formats a Date as its Dhaka calendar date, `YYYY-MM-DD`. */
const dhakaDateKey = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)

/**
 * Pads sparse `{_id: 'YYYY-MM-DD', ...}` aggregation output into a dense,
 * ascending series aligned to `starts`.
 *
 * Charts must not skip a quiet bucket: a gap turns a zero-delivery day into a
 * line that jumps from the day before to the day after, which reads as a steep
 * rise. Each bucket is therefore filled with `defaults` (e.g. `{count: 0}`) so
 * the value is a real zero rather than `undefined`.
 *
 * The aggregation's `_id` key is dropped - the bucket's date is already the
 * `date` field - so the response carries no Mongo internals.
 *
 * @param {Array<Record<string, any>>} rows aggregation results keyed by `_id` date
 * @param {Date[]} starts bucket-start instants, oldest first
 * @param {{timeZone?: string, defaults?: Record<string, number>}} [options]
 */
export const buildSeries = (
  rows = [],
  starts = [],
  { timeZone = BUSINESS_TIMEZONE, defaults = {} } = {}
) => {
  const byDate = new Map(
    rows.map((row) => {
      const { _id, ...values } = row
      return [_id, values]
    })
  )

  return starts.map((start) => {
    const key = dhakaDateKey(start, timeZone)
    return { date: key, ...defaults, ...(byDate.get(key) || {}) }
  })
}
