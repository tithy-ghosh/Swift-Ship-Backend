import { distanceBetweenDistricts } from '../utils/districts.js'
import { legOfParcel } from './delivery-flow.service.js'
import { calculateRiderPayout } from './rider-payout.service.js'

/**
 * Distance for a leg.
 *
 * The parcel is offered in the district of the service centre the rider will
 * visit first, so this is distance from that centre to itself (0) for now.
 * Kept as one function so the day address-level coordinates exist, one place
 * changes.
 *
 * @param {{leg?: string|null, senderServiceCenter: string, receiverServiceCenter: string}} parcel
 */
export const legDistanceKm = (parcel) => {
  if (parcel.leg === 'delivery') {
    return distanceBetweenDistricts(parcel.receiverServiceCenter, parcel.receiverServiceCenter)
  }
  return distanceBetweenDistricts(parcel.senderServiceCenter, parcel.senderServiceCenter)
}

/**
 * The fields written when a rider starts holding a parcel - whether they
 * claimed it themselves (`acceptJob`) or an admin handed it to them
 * (`adminReassignParcel`).
 *
 * This is deliberately one function for both paths. The payout snapshot is
 * what every surface reads afterwards: the offer card, the delivery screen,
 * the completion card, the earnings list and the admin settlement worklist.
 * A handover that skipped it left the row at its schema default - all zeroes
 * with an empty rider uid - so the rider's godown drop credited them ৳0 and
 * the money appeared nowhere in settlement.
 *
 * Returns plain fields rather than performing the write: the accept path
 * needs them inside a conditional `findOneAndUpdate` that doubles as the
 * claim, so the callers own how the update is applied.
 *
 * @param {{
 *   parcel: object,
 *   uid: string,
 *   name: string,
 *   payment: {method?: string, amount?: number}|null,
 *   rateCard: object,
 *   completedToday?: number,
 * }} input
 * @returns {{
 *   leg: 'pickup'|'delivery',
 *   distanceKm: number,
 *   payout: object,
 *   payoutSnapshot: object,
 *   cod: object,
 * }}
 */
export const buildAssignmentFields = ({
  parcel,
  uid,
  name,
  payment,
  rateCard,
  completedToday = 0,
}) => {
  const leg = legOfParcel(parcel)
  const distanceKm = legDistanceKm(parcel)

  // A same-district rider carries the whole route, so their pool is the
  // customer's own delivery cost. A cross-district leg has no customer price
  // of its own - the customer paid once for the journey - so those legs fall
  // back to the leg rate card inside the calculator.
  const payout = calculateRiderPayout(rateCard, {
    deliveryCost: parcel.leg ? null : parcel.deliveryCost,
    distanceKm,
    completedToday,
  })

  const isCod = payment?.method === 'cod'
  // COD is settled with the receiver, so only a delivery-side or same-district
  // rider carries cash. A pickup-leg rider never holds the customer's money.
  const collectsCash = leg !== 'pickup'

  // Cash needed is resolved at assignment time, not at delivery time, so the
  // rider knows before they pick up whether they must carry change.
  // `collectedAt` is reset explicitly: a parcel that was cancelled, returned
  // or handed to another rider must not inherit a declaration from the
  // previous attempt.
  const cod = collectsCash
    ? {
        required: isCod,
        amount: isCod ? payment.amount || 0 : 0,
        depositStatus: isCod ? 'pending' : 'not_required',
        collectedAt: null,
      }
    : { required: false, amount: 0, depositStatus: 'not_required', collectedAt: null }

  const payoutSnapshot = {
    baseFare: payout.baseFare,
    perKmRate: payout.perKmRate,
    distanceKm: payout.distanceKm,
    bonus: payout.bonus,
    total: payout.total,
    riderShare: payout.riderShare,
    companyShare: payout.companyShare,
    // Owner recorded on the leg itself: after a handoff the parcel's
    // assignedRider moves on to the next rider.
    rider: { uid, name },
    status: 'pending',
    batchId: '',
    paidAt: null,
    earnedAt: null,
  }

  return { leg, distanceKm, payout, payoutSnapshot, cod }
}
