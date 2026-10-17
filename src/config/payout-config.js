/**
 * Rider payout configuration — the single source of truth for how riders
 * are paid per delivery.
 *
 * The model is a 40-60 split: the rider keeps 40% of the delivery fare,
 * the company keeps 60% to cover godown operations, line-haul, admin, and
 * profit. Surcharges (weight, night, tips) follow the same split unless
 * noted otherwise.
 *
 * All amounts are in Bangladeshi Taka (৳). Adjust these values to tune
 * the business model — the calculator and UI both read from here.
 */

/** The rider's share of every delivery fare. */
export const RIDER_SHARE_PERCENT = 40

/** The company's share of every delivery fare. */
export const COMPANY_SHARE_PERCENT = 60

/**
 * Surcharges added on top of the base fare. Each surcharge is also split
 * 40-60 between rider and company unless noted otherwise.
 */
export const SURCHARGES = {
  /** Extra charge per kg above the free weight allowance. */
  weightPerKg: 20,
  /** Free weight allowance in kg — no surcharge below this. */
  freeWeightKg: 5,
  /** Extra charge for deliveries completed between 10 PM and 7 AM. */
  nightBonus: 30,
  /** Hour (24h format) when night bonus starts. */
  nightStartHour: 22,
  /** Hour (24h format) when night bonus ends. */
  nightEndHour: 7,
}

/**
 * Customer tips are passed through to the rider in full — the company
 * does not take a cut. This is a deliberate policy to keep tip amounts
 * meaningful and to avoid the rider feeling the platform skims their tips.
 */
export const TIP_RIDER_SHARE_PERCENT = 100

/**
 * Split a fare amount into rider and company shares.
 *
 * The rider's share is rounded and the company takes the remainder, so the
 * two halves always re-add to the original amount — a rider never sees a
 * split whose parts do not sum to the fare they were quoted.
 *
 * @param {number} amount - The total fare/surcharge amount in Taka
 * @param {number} [riderPercent] - The rider's percentage, defaulting to
 *   RIDER_SHARE_PERCENT. Callers pass the rate card's value when it carries
 *   one, so an admin-tuned percentage is honoured without every call site
 *   having to know it.
 * @returns {{rider: number, company: number}} The split amounts
 */
export const splitFare = (amount, riderPercent = RIDER_SHARE_PERCENT) => {
  // `null` means "not configured" rather than "0% for the rider", so it falls
  // back like a missing value rather than zeroing out the rider's pay.
  const parsed =
    riderPercent === null || riderPercent === undefined ? NaN : Number(riderPercent)
  const percent =
    Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : RIDER_SHARE_PERCENT

  const rider = Math.round((amount * percent) / 100)
  const company = amount - rider
  return { rider, company }
}

/**
 * Split a tip amount — rider keeps 100% by default.
 *
 * @param {number} amount - The tip amount in Taka
 * @returns {{rider: number, company: number}} The split amounts
 */
export const splitTip = (amount) => {
  const rider = Math.round((amount * TIP_RIDER_SHARE_PERCENT) / 100)
  const company = amount - rider
  return { rider, company }
}
