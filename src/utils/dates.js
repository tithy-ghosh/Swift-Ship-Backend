/**
 * Bangladesh-local day boundaries.
 *
 * Riders think in "today" starting at midnight Dhaka time. Using the server's
 * own local midnight would silently shift the earnings window for anyone not
 * running the box in UTC+6, which shows up as a day's earnings appearing (or
 * vanishing) at the wrong hour. Every rider-facing date range in this codebase
 * goes through here so the boundary is defined in exactly one place.
 */
export const BUSINESS_TIMEZONE = 'Asia/Dhaka'

/**
 * Offset of `timeZone` from UTC at `date`, in milliseconds.
 *
 * Derived by asking Intl what the wall clock reads in that zone and treating
 * that reading as if it were UTC. Correct across DST boundaries, which the
 * fixed-offset shortcut (+06:00) is not.
 */
const timeZoneOffsetMs = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value
      return acc
    }, {})

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  )

  return asIfUtc - date.getTime()
}

/**
 * The UTC instant of local midnight for the day containing `reference`.
 *
 * @param {Date} [reference]
 * @param {string} [timeZone]
 * @returns {Date}
 */
export const startOfDay = (reference = new Date(), timeZone = BUSINESS_TIMEZONE) => {
  const offset = timeZoneOffsetMs(reference, timeZone)
  const wallClock = new Date(reference.getTime() + offset)

  const localMidnight = Date.UTC(
    wallClock.getUTCFullYear(),
    wallClock.getUTCMonth(),
    wallClock.getUTCDate()
  )

  return new Date(localMidnight - offset)
}

/**
 * Start of the current week (Saturday) in business time.
 *
 * Saturday rather than Monday: the Bangladeshi week runs Saturday to Friday.
 * `getDay()` is 0=Sunday, so Saturday is 6.
 */
export const startOfWeek = (reference = new Date(), timeZone = BUSINESS_TIMEZONE) => {
  const todayStart = startOfDay(reference, timeZone)

  // Shift onto a UTC-midnight instant that carries the *business-time* calendar
  // date, so getUTCDay() reports the local weekday. Reading getUTCDay() off
  // `todayStart` directly would report the UTC weekday of an instant that is
  // six hours behind the local date - which lands on the previous day for every
  // evening, and puts the week boundary a day out.
  const wallClock = new Date(todayStart.getTime() + timeZoneOffsetMs(todayStart, timeZone))

  const daysSinceSaturday = (wallClock.getUTCDay() + 1) % 7

  // Safe to subtract in fixed 24h steps: Asia/Dhaka has no DST.
  return new Date(todayStart.getTime() - daysSinceSaturday * 24 * 60 * 60 * 1000)
}

/**
 * Start of the current calendar month in business time.
 */
export const startOfMonth = (reference = new Date(), timeZone = BUSINESS_TIMEZONE) => {
  const today = startOfDay(reference, timeZone)
  const wallClock = new Date(today.getTime() + timeZoneOffsetMs(today, timeZone))

  return new Date(
    Date.UTC(wallClock.getUTCFullYear(), wallClock.getUTCMonth(), 1) -
      timeZoneOffsetMs(today, timeZone)
  )
}

/**
 * Resolves an earnings range name to its inclusive start instant.
 *
 * @param {'today'|'week'|'month'} range
 * @param {Date} [reference]
 * @returns {Date} Falls back to today for an unknown range rather than
 *   throwing, so a bad query string cannot 500 the screen.
 */
export const resolveRangeStart = (range, reference = new Date()) => {
  if (range === 'week') return startOfWeek(reference)
  if (range === 'month') return startOfMonth(reference)
  return startOfDay(reference)
}
