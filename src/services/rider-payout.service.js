import Setting from '../models/setting.model.js'
import {
  RIDER_SHARE_PERCENT,
  COMPANY_SHARE_PERCENT,
  splitFare,
} from '../config/payout-config.js'

/**
 * Fallback rate card, used only when no Setting document exists yet (a fresh
 * database). Once an admin saves settings, the DB values always win - same
 * arrangement as DEFAULT_PRICING in delivery-pricing.service.js.
 *
 * `riderSharePercent` / `companySharePercent` carry the 40-60 split: the
 * rider keeps the first, the company the second. They live on the rate card
 * (rather than only in code) so an admin can tune the split per market via
 * the same Setting document that controls fares.
 */
export const DEFAULT_RIDER_PAYOUT = {
  baseFare: 40,
  perKmRate: 12,
  minFare: 40,
  riderSharePercent: RIDER_SHARE_PERCENT,
  companySharePercent: COMPANY_SHARE_PERCENT,
  bonus: {
    enabled: true,
    dailyTarget: 6,
    amount: 100,
  },
}

let cachedRateCard = null
let cachedAt = 0
const CACHE_TTL_MS = 30_000

/**
 * A usable percentage in 0-100, or `fallback` when the stored value is
 * missing, non-numeric, or out of range. Keeps a corrupt setting from turning
 * a payout into NaN or a negative share.
 *
 * @param {unknown} value
 * @param {number} fallback
 */
const pickPercent = (value, fallback) => {
  const percent = Number(value)
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return fallback
  return percent
}

/**
 * Resolves the rider rate card currently in effect.
 *
 * @returns {Promise<typeof DEFAULT_RIDER_PAYOUT>}
 */
export const getRiderRateCard = async () => {
  const isCacheFresh = cachedRateCard && Date.now() - cachedAt < CACHE_TTL_MS
  if (isCacheFresh) return cachedRateCard

  const settingsDoc = await Setting.findOne().select('riderPayout').lean()
  const saved = settingsDoc?.riderPayout || {}
  // An admin may have saved either half (or both). Prefer the rider's own
  // percentage; when only the company's was saved, derive the rider's from it
  // rather than reading a company figure as if it were the rider's.
  const riderPercent =
    saved.riderSharePercent !== undefined
      ? pickPercent(saved.riderSharePercent, RIDER_SHARE_PERCENT)
      : saved.companySharePercent !== undefined
        ? 100 - pickPercent(saved.companySharePercent, COMPANY_SHARE_PERCENT)
        : RIDER_SHARE_PERCENT

  cachedRateCard = {
    ...DEFAULT_RIDER_PAYOUT,
    ...saved,
    // Derive both halves from one number. An admin who saved only a rider
    // percentage gets the matching company percentage rather than a stale
    // default that would make the two sum to something other than 100.
    riderSharePercent: riderPercent,
    companySharePercent: 100 - riderPercent,
    bonus: {
      ...DEFAULT_RIDER_PAYOUT.bonus,
      ...(saved.bonus || {}),
    },
  }
  cachedAt = Date.now()

  return cachedRateCard
}

/** Call after any write to Setting.riderPayout. */
export const invalidateRiderRateCardCache = () => {
  cachedRateCard = null
}

/**
 * What the rider earns for one delivery, before any daily bonus.
 *
 * `baseFare + perKmRate x distanceKm`, floored at `minFare`. A rider is never
 * paid less than the minimum for a short hop, and the floor is applied last so
 * it also protects against a zero/negative base fare in a misconfigured card.
 *
 * @param {typeof DEFAULT_RIDER_PAYOUT} rateCard
 * @param {number|null|undefined} distanceKm `null` when coordinates are
 *   unknown. The per-km component is then skipped rather than treated as zero,
 *   so an unknown distance pays the base fare instead of pretending to be 0 km.
 * @returns {{baseFare: number, perKmRate: number, distanceKm: number|null, total: number}}
 */
export const calculateDeliveryPayout = (rateCard, distanceKm) => {
  const { baseFare, perKmRate, minFare } = rateCard
  const rawDistance = Number(distanceKm)
  const hasDistance = Number.isFinite(rawDistance) && rawDistance > 0

  // Round the distance *before* pricing it. Rounding after would mean the
  // stored distanceKm (what the rider sees) and the distance actually paid for
  // disagreed by up to half a paisa of rate.
  const distance = hasDistance ? Math.round(rawDistance * 100) / 100 : null
  const distanceComponent = distance ? perKmRate * distance : 0
  const total = Math.max(baseFare + distanceComponent, minFare)

  return {
    baseFare,
    perKmRate,
    distanceKm: distance,
    total: Math.round(total),
  }
}

/**
 * Whether completing this delivery earns the daily bonus, and how much.
 *
 * The bonus is earned once per day, by the delivery that lands on the target.
 *
 * The comparison is `===`, not `>=`. A rider completes one delivery at a time,
 * so `completed + 1` can only ever equal the target once - whereas `>=` would
 * also pay on every delivery after it, turning a 100 BDT daily bonus into a
 * per-delivery one for anyone working a long shift.
 *
 * @param {typeof DEFAULT_RIDER_PAYOUT} rateCard
 * @param {number} completedToday Deliveries already completed before this one.
 * @returns {{bonus: number, completedToday: number, dailyTarget: number}}
 */
export const calculateDeliveryBonus = (rateCard, completedToday) => {
  const { bonus } = rateCard
  const completed = Math.max(Number(completedToday) || 0, 0)
  const target = Math.max(Number(bonus?.dailyTarget) || 0, 0)
  const reachesTarget = target > 0 && completed + 1 === target

  return {
    bonus: bonus?.enabled && reachesTarget ? Math.max(Number(bonus.amount) || 0, 0) : 0,
    completedToday: completed,
    dailyTarget: target,
  }
}

/**
 * Full payout for one delivery: the rider's share of the fare, plus any
 * bonus unlocked by this delivery.
 *
 * This is the single calculation used both to preview a payout in the job list
 * and to snapshot the authoritative figure onto the parcel when it is accepted.
 *
 * THE 40-60 SPLIT
 *
 * The pool being split is the customer's own delivery cost: the rider keeps
 * 40% of what the customer paid, the company keeps 60% to cover godown
 * operations, line-haul, admin and profit. So a ৳250 delivery pays the rider
 * ৳100 and leaves ৳150 with the company.
 *
 * `minFare` floors the rider's share, not the fare: a short hop priced below
 * the floor still pays the rider the minimum, and the company absorbs the
 * difference. That protects riders from a pricing table that undersells
 * their work.
 *
 * The daily bonus is paid to the rider in full, on top of the split. It is an
 * incentive the company funds, not a fare the customer paid - taking a cut of
 * it would silently shrink the reward the rider was promised.
 *
 * Cross-district legs have no customer price of their own (the customer paid
 * once for the whole journey), so a leg without `deliveryCost` falls back to
 * the leg's rate-card fare as its pool. Splitting a single journey's price
 * between two riders needs a policy that does not exist yet; until it does,
 * the rate card stays the leg's pool and an admin tunes it directly.
 *
 * @param {typeof DEFAULT_RIDER_PAYOUT} rateCard
 * @param {{deliveryCost?: number|null, distanceKm?: number|null, completedToday?: number}} input
 *   `deliveryCost` is the customer's price for this rider's work - the parcel's
 *   delivery charge for a whole-route delivery, or null/absent for a leg.
 * @returns {{baseFare: number, perKmRate: number, distanceKm: number|null, bonus: number, completedToday: number, dailyTarget: number, total: number, riderShare: number, companyShare: number}}
 */
export const calculateRiderPayout = (
  rateCard,
  { deliveryCost, distanceKm, completedToday = 0 } = {}
) => {
  const legFare = calculateDeliveryPayout(rateCard, distanceKm)

  // The pool this rider's work is priced at: the customer's cost when the
  // rider carries the whole route, otherwise the leg's own rate-card fare.
  const rawCost = Number(deliveryCost)
  const hasCustomerPrice = Number.isFinite(rawCost) && rawCost > 0
  const pool = hasCustomerPrice ? Math.round(rawCost) : legFare.total

  const { rider: fareSplit } = splitFare(pool, rateCard.riderSharePercent)
  const minFare = Math.max(Number(rateCard.minFare) || 0, 0)
  const fareShare = Math.max(fareSplit, minFare)

  const { bonus, completedToday: completed, dailyTarget } = calculateDeliveryBonus(
    rateCard,
    completedToday
  )

  return {
    baseFare: legFare.baseFare,
    perKmRate: legFare.perKmRate,
    distanceKm: legFare.distanceKm,
    bonus,
    completedToday: completed,
    dailyTarget,
    // The full fare the split applies to. The rider's own money is riderShare.
    total: pool,
    // The rider's entitlement: their fare share, floored at minFare, plus the
    // whole bonus on top.
    riderShare: fareShare + bonus,
    // What remains with the company from the pool. The `fareShare` (not
    // `fareSplit`) is subtracted so a floored delivery does not invent money:
    // when the floor applies, the company keeps less, and both halves still
    // sum to the pool.
    companyShare: pool - fareShare,
  }
}
