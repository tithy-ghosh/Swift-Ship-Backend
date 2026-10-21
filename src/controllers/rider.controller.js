import asyncHandler from '../middleware/asyncHandler.js'
import Parcel from '../models/parcel.model.js'
import Payment from '../models/payment.model.js'
import RiderApplication from '../models/riderApplication.model.js'
import PayoutRequest from '../models/payoutRequest.model.js'
import RiderRating from '../models/riderRating.model.js'
import Announcement from '../models/announcement.model.js'
import {
  INITIAL_DELIVERY_STATUS,
  TERMINAL_DELIVERY_STATUS,
  LEG_1_COMPLETE_STATUS,
  canConfirmCod,
  canHandoverCod,
  canMarkDelivered,
  legOfParcel,
  nextDeliveryStatus,
  validateDeliveryTransition,
  validateIssueReport,
} from '../services/delivery-flow.service.js'
import {
  getLatestEvent,
  listCompletedDeliveries,
  countCompletedDeliveries,
  findCompletedDelivery,
  appendTrackingEvent,
} from '../services/rider-delivery.service.js'
import { calculateRiderPayout, getRiderRateCard } from '../services/rider-payout.service.js'
import { buildAssignmentFields, legDistanceKm } from '../services/rider-assignment.service.js'
import { districtCoords } from '../utils/districts.js'
import { resolveRangeStart, startOfDay } from '../utils/dates.js'

const MAX_JOBS = 30

/**
 * Which riders can see a job, by leg.
 *
 * A cross-district parcel has two legs, and each leg is offered to riders in a
 * different district:
 *
 *   leg 'pickup'  - offered where the sender is (the rider collects and drops
 *                   at the sending godown).
 *   leg 'delivery'- offered where the receiver is (the rider collects from the
 *                   receiving godown and delivers).
 *
 * Same-district parcels (`leg` null) keep today's single-rider offer: the rider
 * who picks up is the rider who delivers, so the job is shown by the sender.
 *
 * @param {{leg?: string|null, senderServiceCenter: string, receiverServiceCenter: string}} parcel
 */
const legEligible = (parcel, riderDistrict) => {
  if (parcel.leg === 'pickup') return parcel.senderServiceCenter === riderDistrict
  if (parcel.leg === 'delivery') return parcel.receiverServiceCenter === riderDistrict
  return parcel.senderServiceCenter === riderDistrict
}

/**
 * The payout snapshot for a parcel leg, or zeroes when it has not been set yet.
 * Same-district parcels keep their money in the `delivery` leg.
 *
 * Returns a plain object: callers mix leaned parcels and Mongoose documents,
 * and spreading a subdocument copies its internals rather than its fields, so
 * the projection is written out field by field.
 *
 * @param {{leg?: string|null, riderPayouts?: object}} parcel
 * @param {'pickup'|'delivery'} leg
 */
const payoutFor = (parcel, leg) => {
  const snapshot = parcel.riderPayouts?.[leg]
  if (!snapshot) {
    return {
      distanceKm: null,
      total: 0,
      riderShare: 0,
      companyShare: 0,
      baseFare: 0,
      perKmRate: 0,
      bonus: 0,
      rider: { uid: '', name: '' },
      status: 'pending',
      batchId: '',
      paidAt: null,
      earnedAt: null,
    }
  }

  return {
    distanceKm: snapshot.distanceKm ?? null,
    total: snapshot.total || 0,
    // Legs snapshotted before the 40-60 split existed recorded the whole
    // total as the rider's money, and carry the schema default of 0 in
    // riderShare. Surfacing total as the share here means every rider-facing
    // consumer reads one field, and a rider who was quoted the full amount
    // keeps it.
    riderShare: snapshot.riderShare || snapshot.total || 0,
    companyShare: snapshot.companyShare || 0,
    baseFare: snapshot.baseFare || 0,
    perKmRate: snapshot.perKmRate || 0,
    bonus: snapshot.bonus || 0,
    rider: { uid: snapshot.rider?.uid || '', name: snapshot.rider?.name || '' },
    status: snapshot.status || 'pending',
    batchId: snapshot.batchId || '',
    paidAt: snapshot.paidAt || null,
    earnedAt: snapshot.earnedAt || null,
  }
}

/**
 * A "godown" contact point for a leg's hand-off side.
 *
 * The godown is identified by its district's service centre, which is all the
 * rider needs to navigate there. Sender-side godown is the drop of leg 1;
 * receiver-side godown is the pickup of leg 2.
 */
const godownPoint = (serviceCenter, region) => {
  const coords = districtCoords(serviceCenter)
  return {
    name: serviceCenter,
    contact: '',
    region,
    serviceCenter,
    address: '',
    instruction: '',
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
  }
}

/**
 * The shape a rider sees for a job offer or an active delivery.
 *
 * One serialiser for both, so the fields the rider relies on when deciding
 * whether to accept (payout, distance, whether cash is needed) are populated
 * identically once the job is claimed.
 *
 * `pickup` and `drop` are leg-aware: a pickup-leg rider sees the sender as the
 * pickup and the godown as the drop; a delivery-leg rider sees the godown as
 * the pickup and the receiver as the drop. Same-district riders see the usual
 * sender-to-receiver pair.
 *
 * `distanceKm` is read off the parcel, never recomputed here: it is resolved
 * once at accept time and stored, so the number a rider accepted is the number
 * they keep even if the coordinate table later changes.
 *
 * Two leg fields exist and they deliberately differ:
 *
 *   - the payload's `leg` is the RAW value (`null` for a same-district route).
 *     The client needs `null` to tell "one rider, whole route" from "leg 2 of a
 *     hub transfer" - the two walks share five statuses but are labelled very
 *     differently, and a same-district rider must never be told to collect from
 *     a godown they are not standing at.
 *   - `walkLeg` below is the mapped value the state machine wants, where
 *     anything that is not 'pickup' walks the five-step track.
 *
 * @param {object} parcel Leaned Parcel document.
 * @param {string|null} status Current tracking status, or null before accept.
 */
const serializeJob = (parcel, status) => {
  const rawLeg = parcel.leg ?? null
  const walkLeg = legOfParcel(parcel)

  // Same-district parcel: the classic sender-to-receiver pair.
  const mapPickup = {
    name: parcel.senderName,
    contact: parcel.senderContact,
    region: parcel.senderRegion,
    serviceCenter: parcel.senderServiceCenter,
    address: parcel.senderAddress,
    instruction: parcel.pickupInstruction,
    latitude: districtCoords(parcel.senderServiceCenter)?.latitude ?? null,
    longitude: districtCoords(parcel.senderServiceCenter)?.longitude ?? null,
  }
  const mapDrop = {
    name: parcel.receiverName,
    contact: parcel.receiverContact,
    region: parcel.receiverRegion,
    serviceCenter: parcel.receiverServiceCenter,
    address: parcel.receiverAddress,
    instruction: parcel.deliveryInstruction,
    latitude: districtCoords(parcel.receiverServiceCenter)?.latitude ?? null,
    longitude: districtCoords(parcel.receiverServiceCenter)?.longitude ?? null,
  }

  // Cross-district legs swap one end for the godown.
  const pickup =
    rawLeg === 'delivery' ? godownPoint(parcel.receiverServiceCenter, parcel.receiverRegion) : mapPickup
  const drop =
    rawLeg === 'pickup' ? godownPoint(parcel.senderServiceCenter, parcel.senderRegion) : mapDrop

  const distanceKm = parcel.distanceKm ?? null
  // `collectedAt` is the gate the rider app reads: `depositStatus` alone cannot
  // distinguish "cash still owed" from "cash in the rider's pocket", because
  // both are `pending` until an admin deposits. `handedOverAt` is the third
  // step: declared handed over, awaiting the admin's confirmation.
  const cod =
    rawLeg === 'pickup'
      ? {
          required: false,
          amount: 0,
          depositStatus: 'not_required',
          collectedAt: null,
          handedOverAt: null,
        }
      : {
          required: Boolean(parcel.cod?.required),
          amount: parcel.cod?.amount || 0,
          depositStatus: parcel.cod?.depositStatus || 'not_required',
          collectedAt: parcel.cod?.collectedAt || null,
          handedOverAt: parcel.cod?.handedOverAt || null,
        }

  return {
    parcelId: String(parcel._id),
    trackingId: parcel.trackingId,
    type: parcel.type,
    status,
    leg: rawLeg,
    deliveryZone: parcel.deliveryZone,
    nextStatus: status ? nextDeliveryStatus(status, walkLeg) : null,

    pickup,
    drop,

    distanceKm,
    payout: payoutFor(parcel, walkLeg),

    cod,

    acceptedAt: parcel.acceptedAt,
    issues: (parcel.issues || []).map((issue) => ({
      reason: issue.reason,
      note: issue.note,
      reportedAt: issue.reportedAt,
    })),
  }
}

/** GET /api/rider/profile */
export const getRiderProfile = asyncHandler(async (req, res) => {
  const rider = req.rider

  const active = rider.currentParcel
    ? await Parcel.findById(rider.currentParcel).select('trackingId')
    : null

  // Rating summary for this rider.
  const [ratings, ratingCount] = await Promise.all([
    RiderRating.find({ riderId: req.rider._id.toString() })
      .select('rating')
      .sort({ createdAt: -1 }),
    RiderRating.countDocuments({ riderId: req.rider._id.toString() }),
  ])

  const ratingAverage =
    ratings.length > 0
      ? Math.round((ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length) * 10) / 10
      : 0

  res.json({
    rider: {
      name: rider.name,
      phone: rider.phone,
      region: rider.region,
      district: rider.district,
      bikeBrand: rider.bikeBrand,
      bikeRegNumber: rider.bikeRegNumber,
      rating: {
        average: ratingAverage,
        count: ratingCount,
      },
    },
    isOnline: rider.isOnline,
    lastSeenAt: rider.lastSeenAt,
    activeParcelId: active ? String(active._id) : null,
    activeTrackingId: active?.trackingId || null,
    stats: rider.stats,
    payoutDetails: rider.payoutDetails,
  })
})

/** PATCH /api/rider/availability */
export const setAvailability = asyncHandler(async (req, res) => {
  const { isOnline } = req.body

  if (typeof isOnline !== 'boolean') {
    return res.status(400).json({ error: 'isOnline must be a boolean' })
  }

  const rider = await RiderApplication
    .findByIdAndUpdate(
      req.rider._id,
      { $set: { isOnline, lastSeenAt: new Date() } },
      { new: true }
    )
    .select('isOnline lastSeenAt')

  res.json({ isOnline: rider.isOnline, lastSeenAt: rider.lastSeenAt })
})

/** PATCH /api/rider/schedule
 *
 * Sets the rider's weekly availability schedule. Replaces the entire schedule
 * with the provided body. An empty array clears the schedule, which means the
 * rider does not work any day.
 *
 * @param {object[]} req.body weeklySchedule - [{ day: 0-6, slots: [{start, end} minutes from midnight }] }
 */
export const setSchedule = asyncHandler(async (req, res) => {
  const { weeklySchedule } = req.body

  if (!Array.isArray(weeklySchedule)) {
    return res.status(400).json({ error: 'weeklySchedule must be an array' })
  }

  // Validate each day entry.
  for (const entry of weeklySchedule) {
    if (typeof entry.day !== 'number' || entry.day < 0 || entry.day > 6) {
      return res.status(400).json({ error: 'Each day must be a number 0-6' })
    }
    if (!Array.isArray(entry.slots)) {
      return res.status(400).json({ error: 'Each day must have a slots array' })
    }
    for (const slot of entry.slots) {
      if (
        typeof slot.start !== 'number' ||
        typeof slot.end !== 'number' ||
        slot.start < 0 ||
        slot.start > 1440 ||
        slot.end < 0 ||
        slot.end > 1440 ||
        slot.start >= slot.end
      ) {
        return res.status(400).json({ error: 'Each slot needs start < end in minutes from midnight' })
      }
    }
  }

  const rider = await RiderApplication.findByIdAndUpdate(
    req.rider._id,
    { $set: { weeklySchedule, lastSeenAt: new Date() } },
    { new: true }
  ).select('weeklySchedule lastSeenAt')

  res.json({ weeklySchedule: rider.weeklySchedule, lastSeenAt: rider.lastSeenAt })
})

/**
 * GET /api/rider/jobs
 *
 * Claimable parcels whose applicable leg is in the rider's own district,
 * nearest first. District-scoped rather than GPS-scoped on purpose: it needs no
 * device location permission, works on a cheap phone with a weak signal, and
 * matches how the parcel form already collects the pickup area.
 *
 * Three kinds of parcel satisfy one query:
 *   - same-district parcels (offered to the sender's district),
 *   - cross-district parcels awaiting a pickup rider,
 *   - cross-district parcels awaiting a delivery rider at the destination.
 */
export const listNearbyJobs = asyncHandler(async (req, res) => {
  const rider = req.rider

  if (!rider.isOnline) {
    return res.json({ jobs: [], isOnline: false })
  }

  // A rider who is online but outside their scheduled availability gets no jobs.
  const now = new Date()
  const dayOfWeek = now.getDay() // 0 = Sunday
  const minutesFromMidnight = now.getHours() * 60 + now.getMinutes()
  const scheduleEntry = rider.weeklySchedule?.find((entry) => entry.day === dayOfWeek)
  const inScheduledSlot = scheduleEntry?.slots?.some(
    (slot) => minutesFromMidnight >= slot.start && minutesFromMidnight < slot.end
  )
  if (!inScheduledSlot) {
    return res.json({ jobs: [], isOnline: false, outsideSchedule: true })
  }

  const [parcels, rateCard, completedToday] = await Promise.all([
    Parcel.find({
      'assignedRider.uid': null,
      $or: [
        { leg: null, senderServiceCenter: rider.district },
        { leg: 'pickup', senderServiceCenter: rider.district },
        { leg: 'delivery', receiverServiceCenter: rider.district },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(MAX_JOBS)
      .lean(),
    getRiderRateCard(),
    countCompletedDeliveries(req.user.uid, startOfDay()),
  ])

  const jobs = parcels
    .map((parcel) => {
      const distanceKm = legDistanceKm(parcel)
      const job = serializeJob(parcel, INITIAL_DELIVERY_STATUS)

      return {
        ...job,
        // Must be written back, not just fed to the payout calculator:
        // `serializeJob` reads distanceKm off the parcel, which is still null
        // before accept. Without this the card would render "distance unknown"
        // for every order and the nearest-first sort below would compare
        // null - null for every pair and leave the list in arbitrary order.
        distanceKm,
        // The preview reflects today's live bonus position. The authoritative
        // figure is snapshotted onto the parcel when the rider accepts.
        // A whole-route delivery is priced at the customer's cost (40% of it
        // is the rider's share); a cross-district leg falls back to the rate
        // card inside the calculator.
        payout: calculateRiderPayout(rateCard, {
          deliveryCost: parcel.leg ? null : parcel.deliveryCost,
          distanceKm,
          completedToday,
        }),
      }
    })
    .sort((a, b) => {
      // Unknown distance sorts last rather than being dropped: not knowing how
      // far a job is is a reason to show it lower, not to hide it.
      if (a.distanceKm === null) return b.distanceKm === null ? 0 : 1
      if (b.distanceKm === null) return -1
      return a.distanceKm - b.distanceKm
    })

  res.json({ jobs, isOnline: true, completedToday, rateCard })
})

/**
 * POST /api/rider/jobs/:parcelId/accept
 *
 * The claim is a single conditional `findOneAndUpdate` whose filter requires
 * the parcel to still be unassigned AND in the same leg it was offered in.
 * That is what makes two riders tapping Accept at the same moment safe: Mongo
 * applies one of them and the other matches nothing.
 */
export const acceptJob = asyncHandler(async (req, res) => {
  const { parcelId } = req.params
  const rider = req.rider

  if (rider.currentParcel) {
    return res.status(409).json({
      error: 'Finish your current delivery before accepting another.',
    })
  }

  const [parcel, payment, rateCard, completedToday] = await Promise.all([
    Parcel.findById(parcelId).lean(),
    Payment.findOne({ parcel: parcelId }).lean(),
    getRiderRateCard(),
    countCompletedDeliveries(req.user.uid, startOfDay()),
  ])

  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }
  if (parcel.assignedRider?.uid) {
    return res.status(409).json({ error: 'This order has already been taken.' })
  }
  if (!legEligible(parcel, rider.district)) {
    return res.status(403).json({
      error: 'This pickup is outside your area.',
    })
  }

  // The money and cash fields this rider must see for the leg they are taking
  // over. Shared with the admin handover path (`adminReassignParcel`) so the
  // two can never disagree about what a leg pays.
  const { leg, distanceKm, payoutSnapshot, cod } = buildAssignmentFields({
    parcel,
    uid: req.user.uid,
    name: rider.name,
    payment,
    rateCard,
    completedToday,
  })

  const claimed = await Parcel.findOneAndUpdate(
    { _id: parcelId, 'assignedRider.uid': null, leg: parcel.leg },
    {
      $set: {
        // `leg` is deliberately NOT written here: the filter above already
        // proves it is what we expected, and same-district parcels must stay
        // `null` so serializeJob keeps treating them as one continuous route.
        assignedRider: { uid: req.user.uid, name: rider.name },
        assignedAt: new Date(),
        acceptedAt: new Date(),
        distanceKm,
        [`riderPayouts.${leg}`]: payoutSnapshot,
        cod,
      },
    },
    { new: true }
  )

  if (!claimed) {
    return res.status(409).json({ error: 'This order has already been taken.' })
  }

  // `currentParcel: null` in the filter is the second half of the same race:
  // it stops a rider who double-tapped from claiming two parcels. If it matches
  // nothing, the rider picked up a delivery elsewhere in between, so the claim
  // just made has to be handed back - otherwise the parcel sits assigned to
  // someone who will never see it.
  const riderUpdate = await RiderApplication.updateOne(
    { _id: rider._id, currentParcel: null },
    {
      $set: { currentParcel: claimed._id, isOnline: true },
      $inc: { 'stats.totalAccepted': 1 },
    }
  )

  if (!riderUpdate.modifiedCount) {
    await Parcel.updateOne(
      { _id: claimed._id, 'assignedRider.uid': req.user.uid },
      {
        $set: {
          assignedRider: { uid: null, name: '' },
          assignedAt: null,
          acceptedAt: null,
          [`riderPayouts.${leg}`]: {
            baseFare: 0,
            perKmRate: 0,
            distanceKm: null,
            bonus: 0,
            total: 0,
            riderShare: 0,
            companyShare: 0,
            rider: { uid: '', name: '' },
            status: 'pending',
            batchId: '',
            paidAt: null,
            earnedAt: null,
          },
          cod: { required: false, amount: 0, depositStatus: 'not_required', collectedAt: null },
        },
      }
    )

    return res.status(409).json({
      error: 'Finish your current delivery before accepting another.',
    })
  }

  await appendTrackingEvent({
    parcel: claimed,
    status: 'assigned',
    message: `Accepted by ${rider.name}`,
    updatedBy: { uid: req.user.uid, name: rider.name },
  })

  res.status(201).json({ job: serializeJob(claimed, 'assigned') })
})

/** GET /api/rider/deliveries/active */
export const getActiveDelivery = asyncHandler(async (req, res) => {
  const rider = req.rider

  if (!rider.currentParcel) {
    return res.json({ delivery: null })
  }

  const parcel = await Parcel.findById(rider.currentParcel).lean()
  if (!parcel) {
    // The parcel was deleted out from under the rider. Clear the dangling
    // pointer so the app is not stuck showing a job that cannot be completed.
    await RiderApplication.updateOne({ _id: rider._id }, { $set: { currentParcel: null } })
    return res.json({ delivery: null })
  }

  if (parcel.assignedRider?.uid !== req.user.uid) {
    return res.status(403).json({ error: 'This delivery is assigned to another rider.' })
  }

  const { status } = await getLatestEvent(parcel._id)

  res.json({ delivery: serializeJob(parcel, status) })
})

/**
 * GET /api/rider/deliveries/:parcelId
 *
 * A receipt for a delivery this rider has already finished.
 *
 * Separate from `getActiveDelivery` because that one reads
 * `rider.currentParcel`, which the server clears the instant a leg completes -
 * so a finished parcel is simply unreachable through it. Without this endpoint
 * an earnings row could only ever lead a rider to "this delivery is no longer
 * yours", which is a true sentence about nothing they asked.
 *
 * `finishedAt` comes from the completing event, which is the same timestamp
 * `getEarnings` reports as `deliveredAt`, so the receipt and the row agree to
 * the millisecond.
 */
export const getMyDelivery = asyncHandler(async (req, res) => {
  const { parcelId } = req.params

  const completed = await findCompletedDelivery(req.user.uid, parcelId)
  if (!completed) {
    return res.status(404).json({ error: 'Delivery not found.' })
  }

  const { status } = await getLatestEvent(completed.parcel._id)

  res.json({
    delivery: serializeJob(completed.parcel, status),
    finishedAt: completed.deliveredAt,
  })
})

/**
 * POST /api/rider/deliveries/:parcelId/status
 *
 * Advances the delivery one step within the parcel's leg. Ownership is checked
 * here rather than trusting the client, and the transition itself goes through
 * the shared state machine, which knows which statuses each leg may hit.
 */
export const updateDeliveryStatus = asyncHandler(async (req, res) => {
  const { parcelId } = req.params
  const { status: requestedStatus } = req.body
  const rider = req.rider

  const parcel = await Parcel.findById(parcelId)
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }
  if (parcel.assignedRider?.uid !== req.user.uid) {
    return res.status(403).json({ error: 'This delivery is assigned to another rider.' })
  }

  const { status: currentStatus } = await getLatestEvent(parcel._id)
  const leg = legOfParcel(parcel)

  const verdict = validateDeliveryTransition(currentStatus, requestedStatus, leg)
  if (!verdict.ok) {
    return res.status(verdict.status).json({ error: verdict.error })
  }

  const isDelivering = verdict.status === TERMINAL_DELIVERY_STATUS
  const isLegOneDone = verdict.status === LEG_1_COMPLETE_STATUS
  const isCancelling = verdict.status === 'cancelled'
  const isFinishingLeg = isDelivering || isLegOneDone

  // Checked before any write below: finishing a COD parcel freezes its payout
  // and increments the rider's totals, so a delivery that goes through without
  // the cash declaration would pay out against money nobody has recorded taking.
  // The rider app shows the same rule as a disabled button, but the button is
  // only a courtesy - this is the guarantee.
  if (isDelivering && !canMarkDelivered(leg, parcel.cod)) {
    return res
      .status(409)
      .json({ error: 'Confirm the cash you collected before marking this delivered.' })
  }

  if (isDelivering) {
    // Earnings become payable only now, and the rider's running totals move at
    // the same moment, so the two can never disagree.
    await Parcel.updateOne(
      { _id: parcel._id },
      {
        $set: {
          // `earnedAt` is what lets the settlement worklist tell a figure that
          // was merely quoted at accept time from one the rider has finished
          // the work for.
          'riderPayouts.delivery.earnedAt': new Date(),
          'riderPayouts.delivery.status': 'pending',
        },
      }
    )

    await RiderApplication.updateOne(
      { _id: rider._id },
      {
        $inc: {
          'stats.totalCompleted': 1,
          // Through `payoutFor` so a leg snapshotted before the split (whose
          // riderShare default is 0) still credits the rider the full total
          // they were quoted, exactly as their earnings row reports it.
          'stats.totalEarnings': payoutFor(parcel, 'delivery').riderShare,
          'stats.totalCodCollected': parcel.cod?.amount || 0,
        },
      }
    )
  }

  if (isLegOneDone) {
    // Leg 1 done: the parcel is parked at the sending godown and waits for the
    // staff handoff that flips it to leg 'delivery'. The pickup rider is paid
    // the same way delivery riders are - at completion, not at accept.
    await Parcel.updateOne(
      { _id: parcel._id },
      {
        $set: {
          'riderPayouts.pickup.earnedAt': new Date(),
          'riderPayouts.pickup.status': 'pending',
        },
      }
    )

    await RiderApplication.updateOne(
      { _id: rider._id },
      {
        $inc: {
          'stats.totalCompleted': 1,
          // Same grandfathering as the delivery half above.
          'stats.totalEarnings': payoutFor(parcel, 'pickup').riderShare,
        },
      }
    )
  }

  if (isFinishingLeg || isCancelling) {
    await RiderApplication.updateOne(
      { _id: rider._id, currentParcel: parcel._id },
      { $set: { currentParcel: null } }
    )

    // A cancelled parcel returns to the pool: the rider is walking away, so
    // the next eligible rider must be able to claim it. A finished parcel is
    // left assigned to the rider who delivered it for history purposes.
    if (isCancelling) {
      await Parcel.updateOne(
        { _id: parcel._id, 'assignedRider.uid': req.user.uid },
        {
          $set: {
            assignedRider: { uid: null, name: '' },
            assignedAt: null,
            // The rider app does not collect a reason, so cancellations from
            // this path are recorded with a sentinel the report renders as
            // "Stopped by rider". Admin cancellations carry their typed reason.
            cancellation: {
              reason: 'stopped-by-rider',
              cancelledAt: new Date(),
              cancelledBy: { uid: req.user.uid, name: rider.name, role: 'rider' },
            },
          },
        }
      )
    }
  }

  const event = await appendTrackingEvent({
    parcel,
    status: verdict.status,
    message: isDelivering
      ? 'Delivered'
      : isLegOneDone
        ? 'Dropped at godown'
        : isCancelling
          ? 'Delivery stopped by rider'
          : '',
    updatedBy: { uid: req.user.uid, name: rider.name },
  })

  const updated = await Parcel.findById(parcel._id).lean()

  res.json({
    delivery: serializeJob(updated, verdict.status),
    finished: isFinishingLeg || isCancelling,
    // The server's own clock, taken from the event it just wrote rather than
    // from the rider's device. It is the same `eventTime` the earnings screen
    // later reports as `deliveredAt`, so a rider checking a receipt against
    // their history finds the identical second - which is the whole point of
    // giving them a receipt.
    finishedAt: isFinishingLeg ? event.eventTime : null,
  })
})

/** POST /api/rider/deliveries/:parcelId/issue */
export const reportIssue = asyncHandler(async (req, res) => {
  const { parcelId } = req.params
  const { reason, note } = req.body

  const parcel = await Parcel.findById(parcelId).lean()
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }
  if (parcel.assignedRider?.uid !== req.user.uid) {
    return res.status(403).json({ error: 'This delivery is assigned to another rider.' })
  }

  const verdict = validateIssueReport(reason, note)
  if (!verdict.ok) {
    return res.status(400).json({ error: verdict.error })
  }

  await Parcel.updateOne(
    { _id: parcel._id },
    {
      $push: {
        issues: {
          reason: verdict.reason,
          note: verdict.note,
          reportedAt: new Date(),
          reportedBy: { uid: req.user.uid },
        },
      },
    }
  )

  res.status(201).json({ reported: true, reason: verdict.reason })
})

/**
 * POST /api/rider/deliveries/:parcelId/cod
 *
 * The rider declaring they are holding the customer's cash. Records the
 * timestamped amount collected; the deposit itself is confirmed by an admin.
 *
 * Only valid at the customer, because that is the only point at which the cash
 * has actually been handed over. The response carries `collectedAt`, which is
 * what the rider app reads to unblock its "Mark delivered" button.
 */
export const confirmCodCollected = asyncHandler(async (req, res) => {
  const { parcelId } = req.params
  const { amount } = req.body

  const parcel = await Parcel.findById(parcelId).lean()
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }
  if (parcel.assignedRider?.uid !== req.user.uid) {
    return res.status(403).json({ error: 'This delivery is assigned to another rider.' })
  }
  if (!parcel.cod?.required) {
    return res.status(400).json({ error: 'This delivery was not paid cash on delivery.' })
  }

  const collected = Number(amount)
  if (!Number.isFinite(collected) || collected < 0) {
    return res.status(400).json({ error: 'amount must be a number of 0 or more' })
  }
  if (collected !== parcel.cod.amount) {
    return res.status(400).json({
      error: `Collected amount must match the parcel amount of ${parcel.cod.amount}.`,
    })
  }

  // Idempotent: a double tap, or a rider re-opening the screen after the fact,
  // gets the record that already exists rather than a 409 for no reason.
  if (parcel.cod.collectedAt) {
    return res.json({
      cod: {
        amount: parcel.cod.amount,
        collectedAt: parcel.cod.collectedAt,
        depositStatus: parcel.cod.depositStatus,
      },
    })
  }

  const { status: currentStatus } = await getLatestEvent(parcel._id)
  if (!canConfirmCod(currentStatus, parcel.leg)) {
    // Cash is taken from the recipient, so the only moment this can truthfully
    // be declared is when the rider is standing with them. Confirming earlier
    // would put money on record nobody has been handed; confirming later is
    // impossible, because the parcel is already delivered.
    return res.status(409).json({
      error: 'Confirm the cash when you are with the customer, before marking this delivered.',
    })
  }

  const collectedAt = new Date()
  await Parcel.updateOne(
    { _id: parcel._id },
    {
      $set: {
        'cod.collectedAt': collectedAt,
        // `pending` here means "collected, not yet deposited" - the state the
        // admin deposit worklist and the rider's cash-in-pocket total both read.
        'cod.depositStatus': 'pending',
      },
    }
  )

  res.json({
    cod: { amount: parcel.cod.amount, collectedAt, depositStatus: 'pending' },
  })
})

/**
 * The handover record the rider app reads: enough to render "still with you"
 * versus "awaiting confirmation" versus "confirmed" without recomputing the
 * state machine client-side.
 *
 * @param {{amount?: number, collectedAt?: Date|null, handedOverAt?: Date|null, depositStatus?: string}} cod
 */
const serializeCodHandover = (cod) => ({
  amount: cod?.amount || 0,
  collectedAt: cod?.collectedAt || null,
  handedOverAt: cod?.handedOverAt || null,
  depositStatus: cod?.depositStatus || 'not_required',
})

/**
 * POST /api/rider/deliveries/:parcelId/cod/handover
 *
 * The rider declaring they have physically handed the customer's cash to the
 * admin. It records the moment the money left the rider's pocket; it does NOT
 * change `depositStatus`, which stays admin-owned - the admin confirms the
 * receipt through the settlement endpoint, and cannot do so until this flag
 * exists.
 *
 * Idempotent: a double tap, or a rider re-checking their cash list after the
 * fact, gets the record that already exists rather than a 409.
 */
export const handoverCod = asyncHandler(async (req, res) => {
  const { parcelId } = req.params

  const parcel = await Parcel.findById(parcelId).lean()
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }
  if (parcel.assignedRider?.uid !== req.user.uid) {
    return res.status(403).json({ error: 'This delivery is assigned to another rider.' })
  }

  const cod = parcel.cod
  // Already declared - return the existing record, whether or not the admin
  // has since confirmed it.
  if (cod?.handedOverAt) {
    return res.json({ cod: serializeCodHandover(cod) })
  }
  if (!canHandoverCod(cod)) {
    if (!cod?.required) {
      return res.status(400).json({ error: 'This delivery was not paid cash on delivery.' })
    }
    if (cod?.depositStatus === 'deposited') {
      return res.status(409).json({ error: 'The admin has already confirmed this deposit.' })
    }
    return res.status(409).json({ error: 'Collect the cash from the customer first.' })
  }

  const handedOverAt = new Date()
  await Parcel.updateOne(
    { _id: parcel._id },
    { $set: { 'cod.handedOverAt': handedOverAt } }
  )

  res.json({
    cod: serializeCodHandover({ ...cod, handedOverAt }),
  })
})

/** GET /api/rider/earnings?range=today|week|month */
export const getEarnings = asyncHandler(async (req, res) => {
  const { range = 'today' } = req.query
  const since = resolveRangeStart(range)

  const [rateCard, completed, deliveredToday] = await Promise.all([
    getRiderRateCard(),
    listCompletedDeliveries(req.user.uid, since),
    countCompletedDeliveries(req.user.uid, startOfDay()),
  ])

  const deliveries = completed.map(({ parcel, deliveredAt, status }) => {
    const leg = status === LEG_1_COMPLETE_STATUS ? 'pickup' : 'delivery'
    const payout = payoutFor(parcel, leg)

    return {
      // Not the tracking ID: the receipt screen is routed by id, so without
      // this an earnings row has nothing to link to.
      parcelId: String(parcel._id),
      trackingId: parcel.trackingId,
      deliveredAt,
      leg,
      distanceKm: payout.distanceKm ?? null,
      // `earnings` is the rider's entitlement: their share of the fare plus
      // the whole bonus. `total` is the fare pool the split applies to (the
      // customer's own price for a whole-route delivery) and `companyShare`
      // the company's half, carried so the earnings screen can explain where
      // the money went without the client recomputing the split.
      earnings: payout.riderShare || payout.total || 0,
      total: payout.total || 0,
      companyShare: payout.companyShare || 0,
      baseFare: payout.baseFare || 0,
      bonus: payout.bonus || 0,
      payoutStatus: payout.status || 'pending',
      payoutPaidAt: payout.paidAt || null,
      codAmount: parcel.leg === 'pickup' ? 0 : parcel.cod?.required ? parcel.cod.amount || 0 : 0,
      codDepositStatus:
        parcel.leg === 'pickup'
          ? 'not_required'
          : parcel.cod?.depositStatus || 'not_required',
      codHandedOverAt: parcel.leg === 'pickup' ? null : parcel.cod?.handedOverAt || null,
    }
  })

  const totals = deliveries.reduce(
    (acc, row) => {
      acc.earnings += row.earnings
      // The full fare and the company's half, so the earnings screen can show
      // the 40-60 split without re-deriving it from a rounded share total.
      acc.totalFare += row.total
      acc.companyShare += row.companyShare
      acc.baseFare += row.baseFare
      acc.bonus += row.bonus
      acc.codAmount += row.codAmount
      acc.pendingPayout += row.payoutStatus === 'pending' ? row.earnings : 0
      acc.paidPayout += row.payoutStatus === 'paid' ? row.earnings : 0
      // Only cash still in the rider's pocket is a liability. Counting
      // already-deposited collections here would keep telling a rider to hand
      // over money they have already handed over.
      const undeposited = row.codAmount > 0 && row.codDepositStatus === 'pending'
      acc.codPendingAmount += undeposited ? row.codAmount : 0
      // Split the undeposited total into "still with you" and "declared
      // handed over, waiting on the admin" so the earnings screen can tell a
      // rider which of the two they still have to do something about.
      if (undeposited) {
        if (row.codHandedOverAt) acc.codAwaitingConfirmAmount += row.codAmount
        else acc.codHeldAmount += row.codAmount
      }
      return acc
    },
    {
      earnings: 0,
      totalFare: 0,
      companyShare: 0,
      baseFare: 0,
      bonus: 0,
      codAmount: 0,
      codPendingAmount: 0,
      codHeldAmount: 0,
      codAwaitingConfirmAmount: 0,
      pendingPayout: 0,
      paidPayout: 0,
    }
  )

  // Progress toward today's bonus, so the rider can see the next ৳100 coming.
  const bonusProgress = {
    enabled: Boolean(rateCard.bonus?.enabled),
    completedToday: deliveredToday,
    dailyTarget: rateCard.bonus?.dailyTarget || 0,
    amount: rateCard.bonus?.amount || 0,
    remaining: Math.max((rateCard.bonus?.dailyTarget || 0) - deliveredToday, 0),
  }

  res.json({
    range,
    rangeStart: since,
    deliveries,
    totals,
    bonusProgress,
    completedToday: deliveredToday,
    payoutDetails: req.rider.payoutDetails,
    rateCard,
  })
})

/** GET /api/rider/application
 *
 * Returns the authenticated user's own rider application, if one exists.
 * Unlike the other rider endpoints, this does NOT require an approved
 * application - a customer with a pending or rejected application should be
 * able to see where things stand.
 */
export const getRiderApplicationStatus = asyncHandler(async (req, res) => {
  const application = await RiderApplication.findOne({
    userId: req.user.uid,
  }).select('status adminNotes createdAt updatedAt')

  if (!application) {
    return res.json({ application: null })
  }

  res.json({
    application: {
      id: String(application._id),
      status: application.status,
      submittedAt: application.createdAt,
      adminNotes: application.adminNotes || '',
      updatedAt: application.updatedAt,
    },
  })
})

/**
 * What a rider can still withdraw: everything they have ever earned, minus
 * every request pending or already paid. Pending requests count against the
 * balance because that money is earmarked - otherwise a rider could request
 * the same earnings again while the first request is still in flight, and a
 * settled payout plus a second request would drain the pool twice.
 */
const availablePayoutBalance = async (userId, totalEarnings) => {
  const [withdrawn] = await PayoutRequest.aggregate([
    { $match: { userId, status: { $in: ['pending', 'paid'] } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ])

  const earned = Number(totalEarnings) || 0
  return Math.max(earned - (withdrawn?.total || 0), 0)
}

/** GET /api/rider/payouts?status=pending|paid|all
 *
 * The rider's own payout request history - every withdrawal they have asked
 * for, with whether the admin has paid it yet.
 */
export const getRiderPayouts = asyncHandler(async (req, res) => {
  const { status = 'all' } = req.query

  const query = { userId: req.user.uid }
  if (status === 'pending' || status === 'paid' || status === 'rejected') {
    query.status = status
  }

  const [payouts, rider] = await Promise.all([
    PayoutRequest.find(query)
      .select('amount status requestedAt paidAt note method number')
      .sort({ requestedAt: -1 }),
    RiderApplication.findOne({ userId: req.user.uid }).select('stats'),
  ])

  // The same figure the request endpoint enforces, so the button the rider
  // sees and the ceiling the server applies can never disagree.
  const availableBalance = await availablePayoutBalance(
    req.user.uid,
    rider?.stats?.totalEarnings,
  )

  res.json({
    payouts: payouts.map((p) => ({
      id: String(p._id),
      amount: p.amount,
      status: p.status,
      requestedAt: p.requestedAt,
      paidAt: p.paidAt,
      note: p.note || '',
      method: p.method,
      number: p.number,
    })),
    availableBalance,
  })
})

/** POST /api/rider/payouts
 *
 * Request a withdrawal of available earnings to the rider's payout account.
 * One pending request at a time per rider.
 */
export const requestRiderPayout = asyncHandler(async (req, res) => {
  const { amount } = req.body

  const requested = Number(amount)
  if (!Number.isFinite(requested) || requested <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' })
  }

  // One pending request at a time.
  const existing = await PayoutRequest.findOne({
    userId: req.user.uid,
    status: 'pending',
  })
  if (existing) {
    return res.status(409).json({
      error: 'You already have a pending payout request. Wait for it to be paid or rejected before requesting again.',
    })
  }

  const rider = await RiderApplication.findOne({
    userId: req.user.uid,
    status: 'approved',
  }).select('payoutDetails stats')

  if (!rider) {
    return res.status(403).json({ error: 'No approved rider profile found.' })
  }

  // Validate against what is actually left: lifetime earnings minus every
  // request pending or already paid. Raw lifetime earnings would let the same
  // money be requested again once an earlier payout is settled.
  const availableBalance = await availablePayoutBalance(
    req.user.uid,
    rider.stats?.totalEarnings,
  )

  if (requested > availableBalance) {
    return res.status(400).json({
      error: `Requested amount exceeds your available balance of ৳${availableBalance}.`,
    })
  }

  const payout = await PayoutRequest.create({
    userId: req.user.uid,
    amount: requested,
    status: 'pending',
    method: rider.payoutDetails?.method || 'bkash',
    number: rider.payoutDetails?.number || '',
  })

  res.status(201).json({
    payout: {
      id: String(payout._id),
      amount: payout.amount,
      status: payout.status,
      requestedAt: payout.requestedAt,
    },
  })
})

/** GET /api/rider/ratings/me
 *
 * The authenticated rider's own rating summary and recent reviews.
 */
export const getRiderRatingsMe = asyncHandler(async (req, res) => {
  const ratings = await RiderRating.find({ riderId: req.user.uid })
    .select('rating comment createdAt customerName')
    .sort({ createdAt: -1 })
    .limit(50)

  const average =
    ratings.length > 0
      ? ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length
      : 0

  res.json({
    average: Math.round(average * 10) / 10,
    count: ratings.length,
    ratings: ratings.map((r) => ({
      id: String(r._id),
      rating: r.rating,
      comment: r.comment,
      customerName: r.customerName,
      createdAt: r.createdAt,
    })),
  })
})

/** GET /api/rider/ratings?riderId=...
 *
 * Public read of a rider's ratings - average and recent reviews.
 * No authentication required: a customer checking a rider before booking
 * should be able to see the rating.
 */
export const getRiderRatings = asyncHandler(async (req, res) => {
  const { riderId } = req.query

  if (!riderId) {
    return res.status(400).json({ error: 'riderId is required' })
  }

  const ratings = await RiderRating.find({ riderId })
    .select('rating comment createdAt customerName')
    .sort({ createdAt: -1 })
    .limit(20)

  const average =
    ratings.length > 0
      ? ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length
      : 0

  res.json({
    average: Math.round(average * 10) / 10,
    count: ratings.length,
    ratings: ratings.map((r) => ({
      id: String(r._id),
      rating: r.rating,
      comment: r.comment,
      customerName: r.customerName,
      createdAt: r.createdAt,
    })),
  })
})

/** POST /api/rider/ratings
 *
 * A customer rates a rider after a delivery is completed.
 * One rating per parcel per customer.
 *
 * @param {string} req.body.parcelId
 * @param {number} req.body.rating - 1 to 5
 * @param {string} [req.body.comment]
 */
export const submitRiderRating = asyncHandler(async (req, res) => {
  const { parcelId, rating, comment } = req.body

  if (!parcelId) {
    return res.status(400).json({ error: 'parcelId is required' })
  }
  if (typeof rating !== 'number' || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be a number between 1 and 5' })
  }

  const parcel = await Parcel.findById(parcelId).lean()
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  // Only a delivery-leg or same-district rider can be rated by the receiver.
  // The parcel's assignedRider at completion is the rider who delivered it.
  if (!parcel.assignedRider || !parcel.assignedRider.uid) {
    return res.status(400).json({ error: 'This parcel has no assigned rider.' })
  }

  // Verify the delivery is actually completed (has a terminal tracking event).
  const { status: latestStatus } = await getLatestEvent(parcel._id)
  if (latestStatus !== 'delivered') {
    return res.status(400).json({ error: 'You can only rate a completed delivery.' })
  }

  // The customer is the receiver of the parcel.
  const customerId = req.user.uid
  const customerName = req.user.name || 'Customer'

  const existing = await RiderRating.findOne({ parcelId, customerId })
  if (existing) {
    return res.status(409).json({ error: 'You have already rated this delivery.' })
  }

  const newRating = await RiderRating.create({
    riderId: parcel.assignedRider.uid,
    parcelId,
    customerId,
    customerName,
    rating,
    comment: comment || '',
  })

  res.status(201).json({
    id: String(newRating._id),
    rating: newRating.rating,
    comment: newRating.comment,
    customerName: newRating.customerName,
    createdAt: newRating.createdAt,
  })
})

/** POST /api/rider/documents
 *
 * Links uploaded document URLs to the rider's application.
 * Called after successful Cloudinary upload via POST /api/upload/document.
 *
 * @param {string} req.body.documentType - nid, license, or bikeRegistration
 * @param {string} req.body.url - Cloudinary secure_url
 */
export const submitRiderDocuments = asyncHandler(async (req, res) => {
  const { documentType, url } = req.body

  const validTypes = ['nid', 'license', 'bikeRegistration']
  if (!documentType || !validTypes.includes(documentType)) {
    return res.status(400).json({ error: 'Invalid document type.' })
  }
  if (!url) {
    return res.status(400).json({ error: 'Document URL is required.' })
  }

  const rider = await RiderApplication.findOne({ userId: req.user.uid })
  if (!rider) {
    return res.status(404).json({ error: 'No rider application found.' })
  }

  await RiderApplication.findByIdAndUpdate(rider._id, {
    $set: {
      [`documents.${documentType}.url`]: url,
      [`documents.${documentType}.status`]: 'pending',
      // A replacement starts a new review; the previous rejection no longer
      // describes the uploaded file.
      [`documents.${documentType}.rejectedAt`]: null,
      [`documents.${documentType}.rejectedReason`]: '',
      documentsStatus: 'pending',
    },
  })

  res.json({
    documentType,
    url,
    status: 'pending',
  })
})

/** GET /api/rider/documents
 *
 * Returns the authenticated rider's document status.
 */
export const getRiderDocuments = asyncHandler(async (req, res) => {
  const rider = await RiderApplication.findOne({ userId: req.user.uid })
    .select('documents documentsStatus status')

  if (!rider) {
    return res.status(404).json({ error: 'No rider application found.' })
  }

  res.json({
    documents: rider.documents,
    documentsStatus: rider.documentsStatus,
    applicationStatus: rider.status,
  })
})

/** GET /api/rider/announcements/active
 *
 * Returns active announcements for riders and customers.
 * No role check - any logged-in user can see announcements relevant to them.
 *
 * Query params:
 *   target - filter by target type ('rider', 'customer', 'all')
 */
export const getActiveAnnouncements = asyncHandler(async (req, res) => {
  const { target } = req.query
  const now = new Date()

  const match = {
    isActive: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }
  if (target) match.target = target

  const announcements = await Announcement.find(match)
    .sort({ createdAt: -1 })
    .lean()

  res.json({
    announcements: announcements.map((a) => ({
      id: String(a._id),
      title: a.title,
      body: a.body,
      target: a.target,
      createdAt: a.createdAt,
    })),
  })
})