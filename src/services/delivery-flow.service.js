/**
 * The rider's delivery progress machine.
 *
 * A parcel has one or two legs depending on whether it crosses districts:
 *
 *   Same-district: a single rider does the whole route. The walk is the classic
 *   five moments a rider already knows:
 *
 *     accepted            -> assigned
 *     reached pickup      -> in-transit
 *     picked up           -> picked-up
 *     reached customer    -> out-for-delivery
 *     delivered           -> delivered   (terminal)
 *
 *   Cross-district: the hub model. Rider A collects from the customer and drops
 *   the parcel at the sending godown. Staff move it godown-to-godown (outside
 *   the rider app). Rider B collects it from the receiving godown and delivers.
 *   Each leg has its own walk, its own rider and its own payout:
 *
 *     Leg 1 (pickup):
 *       accepted            -> assigned
 *       reached sender      -> in-transit
 *       picked up           -> picked-up
 *       dropped at godown   -> at-godown   (terminal for this leg)
 *
 *     Leg 2 (delivery):     the same five-step walk as same-district, where
 *       "pickup" means the receiving godown.
 *
 * These map onto the existing TRACKING_STATUSES enum rather than introducing
 * whole new statuses, so the public /track page and the STATUS_META maps keep
 * working. `at-godown` is the only new value, and it is needed because "dropped
 * at the godown" is a real moment customers can follow.
 *
 * The tracking endpoint this replaced let any rider move any parcel to any
 * status in any order, including backwards. Everything below exists to make
 * that impossible.
 */

/** Rider-facing steps for the classic single-rider delivery. */
export const DELIVERY_STEPS = ['assigned', 'in-transit', 'picked-up', 'out-for-delivery', 'delivered']

/** Rider-facing steps for the cross-district pickup leg (Leg 1). */
export const PICKUP_LEG_STEPS = ['assigned', 'in-transit', 'picked-up', 'at-godown']

/** Rider-facing steps for the cross-district delivery leg (Leg 2). */
export const LEG_2_DELIVERY_STEPS = DELIVERY_STEPS

/** The status a parcel sits at before a rider accepts it. */
export const INITIAL_DELIVERY_STATUS = 'pending'

export const TERMINAL_DELIVERY_STATUS = 'delivered'

/** The status that finishes Leg 1: the parcel is parked at the sending godown. */
export const LEG_1_COMPLETE_STATUS = 'at-godown'

/**
 * Statuses a rider is allowed to ask for.
 *
 * `cancelled` is a valid Tracking status but is not a forward *step*, so it
 * sits outside both walks and has to be admitted separately - otherwise the
 * state machine would reject the one action that lets a rider walk away from an
 * impossible job.
 */
const REQUESTABLE_STATUSES = [...new Set([...DELIVERY_STEPS, LEG_1_COMPLETE_STATUS, 'cancelled'])]

/** Reasons a rider can give when reporting a problem. */
export const DELIVERY_ISSUE_REASONS = [
  'customer_unreachable',
  'wrong_address',
  'recipient_refused',
  'merchant_unreachable',
  'parcel_damaged',
  'payment_refused',
  'other',
]

const REQUESTABLE_SET = new Set(REQUESTABLE_STATUSES)
const ISSUE_REASON_SET = new Set(DELIVERY_ISSUE_REASONS)

/** The walk for a given leg: Leg 1 is shorter because it ends at the godown. */
export const stepsForLeg = (leg) =>
  leg === 'pickup' ? PICKUP_LEG_STEPS : LEG_2_DELIVERY_STEPS

/**
 * How to read a parcel's leg.
 *
 * `parcel.leg` is `null` for a same-district route (a single rider does it all)
 * and `'pickup'` or `'delivery'` for cross-district routes. Encoding leg on the
 * parcel keeps the state machine stateless: it just needs the parcel to decide
 * the walk.
 *
 * @param {{leg?: string|null}} parcel
 * @returns {'pickup'|'delivery'}
 */
export const legOfParcel = (parcel) => (parcel?.leg === 'pickup' ? 'pickup' : 'delivery')

/** The single status a delivery may move to from `currentStatus`, within a leg. */
export const nextDeliveryStatus = (currentStatus, leg = null) => {
  const steps = stepsForLeg(leg)
  if (!steps.includes(currentStatus)) return null
  const index = steps.indexOf(currentStatus)
  return steps[index + 1] || null
}

/**
 * Validates a requested transition.
 *
 * Forward-only, one step at a time, within the walk for the given leg. A Leg-1
 * rider physically cannot reach `delivered` (their walk ends at `at-godown`),
 * and a Leg-2 rider cannot go back towards the pickup.
 *
 * `cancelled` is allowed from any non-terminal state so a rider is never
 * trapped on a job they cannot finish.
 *
 * @param {string} currentStatus
 * @param {string} requestedStatus
 * @param {'pickup'|'delivery'|null} [leg] Null = single-rider delivery.
 * @returns {{ok: true, status: string} | {ok: false, status: number, error: string}}
 */
export const validateDeliveryTransition = (currentStatus, requestedStatus, leg = null) => {
  if (!REQUESTABLE_SET.has(requestedStatus)) {
    return {
      ok: false,
      status: 400,
      error: `status must be one of: ${REQUESTABLE_STATUSES.join(', ')}`,
    }
  }

  // Finished legs are frozen. `delivered` is the ending for leg 2 (and for a
  // same-district route); `at-godown` is the ending for leg 1. Both riders have
  // been paid by then, so there is nothing left to advance - and cancelling a
  // leg that is already paid would hand the parcel back to the claim pool.
  if (
    currentStatus === TERMINAL_DELIVERY_STATUS ||
    (leg === 'pickup' && currentStatus === LEG_1_COMPLETE_STATUS)
  ) {
    return {
      ok: false,
      status: 409,
      error: 'This delivery is already completed.',
    }
  }

  if (requestedStatus === 'cancelled') {
    return { ok: true, status: 'cancelled' }
  }

  // A parcel that has never been accepted has no rider progress to advance.
  const steps = stepsForLeg(leg)
  const currentIndex = steps.indexOf(currentStatus)
  if (currentIndex === -1) {
    return {
      ok: false,
      status: 409,
      error: 'This delivery has not been accepted yet.',
    }
  }

  const requestedIndex = steps.indexOf(requestedStatus)
  if (requestedIndex !== currentIndex + 1) {
    return {
      ok: false,
      status: 409,
      error: `Cannot move from ${currentStatus} to ${requestedStatus}. Expected ${
        steps[currentIndex + 1]
      }.`,
    }
  }

  return { ok: true, status: requestedStatus }
}

/**
 * Coerces an issue reason to a known value.
 *
 * @returns {{ok: true, reason: string, note: string} | {ok: false, error: string}}
 */
export const validateIssueReport = (reason, note = '') => {
  if (!ISSUE_REASON_SET.has(reason)) {
    return {
      ok: false,
      error: `reason must be one of: ${DELIVERY_ISSUE_REASONS.join(', ')}`,
    }
  }

  const trimmedNote = String(note || '').trim().slice(0, 500)
  if (reason === 'other' && !trimmedNote) {
    return { ok: false, error: 'A note is required when reason is "other".' }
  }

  return { ok: true, reason, note: trimmedNote }
}

/**
 * The one status at which cash changes hands.
 *
 * Cash on delivery is collected from the recipient, so it can only be declared
 * once the rider is actually with them - the step the app labels "At customer",
 * stored as `out-for-delivery`. Every earlier step would let a rider record
 * money nobody has handed them yet, and the step after it is `delivered`,
 * which is precisely the write these predicates guard.
 */
export const COD_CONFIRM_STATUS = 'out-for-delivery'

/**
 * Whether the rider on a given leg ever holds the customer's cash.
 *
 * A pickup-leg rider hands the parcel straight to the godown and never sees the
 * money - COD is deferred to leg 2 when the claim is made.
 *
 * @param {'pickup'|'delivery'|null} [leg]
 */
export const codCollectsOnLeg = (leg) => leg !== 'pickup'

/**
 * True when the rider may declare the customer's cash collected.
 *
 * @param {string} currentStatus
 * @param {'pickup'|'delivery'|null} [leg]
 */
export const canConfirmCod = (currentStatus, leg = null) =>
  codCollectsOnLeg(leg) && currentStatus === COD_CONFIRM_STATUS

/**
 * True when a rider may move the parcel to `delivered`.
 *
 * Beyond the state machine itself, one condition applies: a COD parcel cannot
 * be finished without a declaration that the cash was collected. The payout is
 * frozen and the rider's running totals move at that moment, so an unchecked
 * finish would leave money in a rider's pocket with nothing on record saying
 * it should be there.
 *
 * @param {'pickup'|'delivery'|null} [leg]
 * @param {{required?: boolean, collectedAt?: Date|string|null}|null} [cod]
 */
export const canMarkDelivered = (leg = null, cod = null) =>
  !codCollectsOnLeg(leg) || !cod?.required || Boolean(cod?.collectedAt)

/**
 * True when the rider may record the cash as handed over to the admin.
 *
 * Only meaningful once the cash was actually collected, and only until an
 * admin has already confirmed it - after that the rider no longer holds the
 * money and re-declaring a handover would rewrite history.
 *
 * @param {{required?: boolean, collectedAt?: Date|string|null, handedOverAt?: Date|string|null, depositStatus?: string}|null} [cod]
 */
export const canHandoverCod = (cod = null) =>
  Boolean(cod?.required) &&
  Boolean(cod?.collectedAt) &&
  !cod?.handedOverAt &&
  cod?.depositStatus !== 'deposited'

/**
 * True when the admin may confirm the deposit.
 *
 * Confirmation is of something the rider declared: without `handedOverAt`
 * there is no handover on record to confirm, and once `deposited` the state
 * is final.
 *
 * @param {{collectedAt?: Date|string|null, handedOverAt?: Date|string|null, depositStatus?: string}|null} [cod]
 */
export const canConfirmCodDeposit = (cod = null) =>
  Boolean(cod?.collectedAt) &&
  Boolean(cod?.handedOverAt) &&
  cod?.depositStatus !== 'deposited'