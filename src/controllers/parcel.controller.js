import mongoose from 'mongoose'
import asyncHandler from '../middleware/asyncHandler.js'
import Parcel from '../models/parcel.model.js'
import Payment from '../models/payment.model.js'
import Setting from '../models/setting.model.js'
import Tracking, { TRACKING_STATUSES } from '../models/tracking.model.js'
import RiderApplication from '../models/riderApplication.model.js'
import { calculateDeliveryCharge } from '../services/delivery-pricing.service.js'
import { countCompletedDeliveries, getLatestEvent } from '../services/rider-delivery.service.js'
import { buildAssignmentFields } from '../services/rider-assignment.service.js'
import { getRiderRateCard } from '../services/rider-payout.service.js'
import { generateTrackingId } from '../utils/tracking.js'
import { startOfDay } from '../utils/dates.js'
import { logAdminAction } from '../services/activity-log.service.js'

const PARCEL_TYPES = new Set(['document', 'non-document'])
const PAYMENT_METHODS = new Set(['cod', 'online'])
const TRACKING_STATUS_SET = new Set(TRACKING_STATUSES)

/**
 * POST /api/parcels/quote
 *
 * Calculates a quote without writing to the database.
 */
export const createQuote = async (req, res) => {
  const { type, weight, senderServiceCenter, receiverServiceCenter } = req.body

  if (!PARCEL_TYPES.has(type) || !senderServiceCenter || !receiverServiceCenter) {
    return res.status(400).json({
      error: 'type, senderServiceCenter, and receiverServiceCenter are required',
    })
  }

  const pricing = await calculateDeliveryCharge({
    type,
    weight,
    senderServiceCenter,
    receiverServiceCenter,
  })

  return res.json({ trackingId: generateTrackingId(), ...pricing })
}

/**
 * POST /api/parcels
 *
 * Persists a confirmed parcel. Pricing is recalculated to prevent clients from
 * submitting a manipulated delivery cost.
 */
export const createParcel = async (req, res) => {
  const {
    trackingId,
    type,
    title,
    weight,
    senderName,
    senderContact,
    senderRegion,
    senderServiceCenter,
    senderAddress,
    pickupInstruction,
    receiverName,
    receiverContact,
    receiverRegion,
    receiverServiceCenter,
    receiverAddress,
    deliveryInstruction,
    paymentMethod,
  } = req.body

  const requiredFields = {
    trackingId,
    type,
    senderName,
    senderContact,
    senderRegion,
    senderServiceCenter,
    receiverName,
    receiverContact,
    receiverRegion,
    receiverServiceCenter,
  }
  const missingFields = Object.entries(requiredFields)
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missingFields.length) {
    return res.status(400).json({ error: `Missing required fields: ${missingFields.join(', ')}` })
  }
  if (!PARCEL_TYPES.has(type)) {
    return res.status(400).json({ error: 'type must be document or non-document' })
  }
  if (!PAYMENT_METHODS.has(paymentMethod)) {
    return res.status(400).json({ error: 'paymentMethod must be cod or online' })
  }

  // The public booking page is gated too, but the API is the authority: a
  // direct request must not create a parcel while the switch is off.
  const settings = await Setting.findOne().select('system.allowNewParcelBookings').lean()
  if (settings?.system?.allowNewParcelBookings === false) {
    return res.status(403).json({
      error: 'New parcel bookings are currently paused. Please try again later.',
      code: 'BOOKINGS_PAUSED',
    })
  }

  const pricing = await calculateDeliveryCharge({
    type,
    weight,
    senderServiceCenter,
    receiverServiceCenter,
  })

  // The routing model is decided once, here, from the two service centres:
  // same district stays a single-rider route (`leg` null), cross-district
  // starts on leg 1 (rider collects and parks it at the sending godown).
  const crossDistrict = senderServiceCenter !== receiverServiceCenter

  const parcel = await Parcel.create({
    trackingId,
    type,
    title,
    weight,
    senderName,
    senderContact,
    senderRegion,
    senderServiceCenter,
    senderAddress,
    pickupInstruction,
    receiverName,
    receiverContact,
    receiverRegion,
    receiverServiceCenter,
    receiverAddress,
    deliveryInstruction,
    leg: crossDistrict ? 'pickup' : null,
    ...pricing,
    createdBy: {
      uid: req.user.uid,
      email: req.user.email,
      name: senderName,
    },
  })

  try {
    const [payment, tracking] = await Promise.all([
      Payment.create({
        parcel: parcel._id,
        trackingId: parcel.trackingId,
        method: paymentMethod,
        status: 'pending',
        amount: parcel.deliveryCost,
      }),
      Tracking.create({
        parcel: parcel._id,
        trackingId: parcel.trackingId,
        status: 'pending',
        message: 'Parcel booking created',
        updatedBy: {
          uid: req.user.uid,
          name: senderName,
        },
      }),
    ])

    return res.status(201).json({
      ...parcel.toObject(),
      payment,
      currentStatus: tracking.status,
    })
  } catch (error) {
    await Promise.allSettled([
      Payment.deleteMany({ parcel: parcel._id }),
      Tracking.deleteMany({ parcel: parcel._id }),
      parcel.deleteOne(),
    ])
    throw error
  }
}

/** GET /api/parcels/my */
export const listMyParcels = async (req, res) => {
  const parcels = await Parcel.find({ 'createdBy.uid': req.user.uid })
    .sort({ createdAt: -1 })
    .lean()
  const parcelIds = parcels.map(({ _id }) => _id)
  const [payments, trackingEvents] = await Promise.all([
    Payment.find({ parcel: { $in: parcelIds } }).lean(),
    Tracking.aggregate([
      { $match: { parcel: { $in: parcelIds } } },
      { $sort: { eventTime: -1, createdAt: -1 } },
      { $group: { _id: '$parcel', currentStatus: { $first: '$status' } } },
    ]),
  ])
  const paymentByParcel = new Map(payments.map((item) => [String(item.parcel), item]))
  const statusByParcel = new Map(
    trackingEvents.map((item) => [String(item._id), item.currentStatus])
  )

  return res.json(
    parcels.map((parcel) => ({
      ...parcel,
      payment: paymentByParcel.get(String(parcel._id)) || null,
      currentStatus: statusByParcel.get(String(parcel._id)) || null,
    }))
  )
}

/** GET /api/parcels/track/:trackingId */
export const trackParcel = async (req, res) => {
  const trackingId = String(req.params.trackingId).trim().toUpperCase()
  const parcel = await Parcel.findOne({ trackingId }).select(
    'trackingId deliveryZone senderServiceCenter receiverServiceCenter createdAt'
  )

  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  const events = await Tracking.find({ parcel: parcel._id })
    .select('status location message eventTime createdAt')
    .sort({ eventTime: -1, createdAt: -1 })

  return res.json({
    parcel,
    currentStatus: events[0]?.status || null,
    events,
  })
}

/** DELETE /api/parcels/:id */
export const deleteParcel = async (req, res) => {
  const parcel = await Parcel.findById(req.params.id)

  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }
  if (parcel.createdBy.uid !== req.user.uid) {
    return res.status(403).json({ error: 'Not authorized to delete this parcel' })
  }

  await Promise.all([
    Payment.deleteMany({ parcel: parcel._id }),
    Tracking.deleteMany({ parcel: parcel._id }),
    parcel.deleteOne(),
  ])
  return res.json({ message: 'Parcel deleted successfully' })
}
 /**
 * GET /api/parcels
 * Admin only: Get all parcels with payment and tracking info
 */
export const getAllParcels = asyncHandler(async (req, res) => {
  // Get all parcels sorted by newest first
  const parcels = await Parcel.find()
    .sort({ createdAt: -1 })
    .lean();

  // Get all parcel IDs to fetch related payments and tracking
  const parcelIds = parcels.map(({ _id }) => _id);

  // Fetch payments and current tracking status for all parcels
  const [payments, trackingEvents] = await Promise.all([
    Payment.find({ parcel: { $in: parcelIds } }).lean(),
    Tracking.aggregate([
      { $match: { parcel: { $in: parcelIds } } },
      { $sort: { eventTime: -1, createdAt: -1 } },
      { $group: { _id: '$parcel', currentStatus: { $first: '$status' } } },
    ]),
  ]);

  // Create maps for quick lookup
  const paymentByParcel = new Map(
    payments.map((item) => [String(item.parcel), item])
  );
  const statusByParcel = new Map(
    trackingEvents.map((item) => [String(item._id), item.currentStatus])
  );

  // Combine parcel data with payment and status info
  const parcelsWithDetails = parcels.map((parcel) => ({
    ...parcel,
    payment: paymentByParcel.get(String(parcel._id)) || null,
    currentStatus: statusByParcel.get(String(parcel._id)) || null,
  }));

  return res.status(200).json(parcelsWithDetails);
});

/**
 * PATCH /api/parcels/:id/status
 * Admin only: force a parcel's tracking status.
 *
 * Tracking is the single source of truth for a parcel's status, so an override
 * appends a new event rather than writing a field that does not exist. This is
 * a support lever for a stuck or mis-tracked parcel, not a normal transition,
 * so it deliberately bypasses the rider state machine.
 */
export const adminUpdateParcelStatus = asyncHandler(async (req, res) => {
  const { id } = req.params
  const { status, message = '' } = req.body

  if (!TRACKING_STATUS_SET.has(status)) {
    return res.status(400).json({
      error: `status must be one of: ${TRACKING_STATUSES.join(', ')}`,
    })
  }

  const parcel = await Parcel.findById(id)
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  await Tracking.create({
    parcel: parcel._id,
    trackingId: parcel.trackingId,
    status,
    message: message || `Status set to "${status}" by admin`,
    eventTime: new Date(),
    updatedBy: { uid: req.user.uid, name: req.adminUser?.name || 'Swift Ship' },
  })

  // The activity log is the audit trail of who did what, so it is recorded
  // only after the change has succeeded.
  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.user.name || req.user.email,
    action: 'update_parcel_status',
    targetType: 'parcel',
    targetId: parcel._id,
    targetName: parcel.trackingId,
    details: { status, message },
  })

  return res.status(200).json({ ...parcel.toObject(), currentStatus: status })
})

/**
 * PATCH /api/parcels/:id/cancel
 * Admin only: stop a parcel and record why.
 *
 * Mirrors the rider's cancellation: the assigned rider is released back into
 * the pool (a cancelled parcel must become claimable again) and the reason is
 * written into the tracking log, which is the only audit trail parcels have.
 */
export const adminCancelParcel = asyncHandler(async (req, res) => {
  const { id } = req.params
  const reason = String(req.body.reason || '').trim()

  if (!reason) {
    return res.status(400).json({ error: 'A cancellation reason is required' })
  }

  const parcel = await Parcel.findById(id)
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  if (parcel.assignedRider?.uid) {
    await RiderApplication.updateOne(
      { userId: parcel.assignedRider.uid, currentParcel: parcel._id },
      { $set: { currentParcel: null } }
    )
    await Parcel.updateOne(
      { _id: parcel._id },
      { $set: { assignedRider: { uid: null, name: '' }, assignedAt: null } }
    )
  }

  const cancelledAt = new Date()

  // Persist the reason on the parcel itself. The activity log already records
  // it, but that trail is admin-scoped and unqueryable for a report; this is
  // what lets analytics group cancellations by reason.
  await Parcel.updateOne(
    { _id: parcel._id },
    {
      $set: {
        cancellation: {
          reason,
          cancelledAt,
          cancelledBy: {
            uid: req.user.uid,
            name: req.adminUser?.name || req.user.name || req.user.email || 'Swift Ship',
            role: 'admin',
          },
        },
      },
    }
  )

  await Tracking.create({
    parcel: parcel._id,
    trackingId: parcel.trackingId,
    status: 'cancelled',
    message: `Cancelled by admin: ${reason}`,
    eventTime: cancelledAt,
    updatedBy: { uid: req.user.uid, name: req.adminUser?.name || 'Swift Ship' },
  })

  // The activity log is the audit trail of who did what, so it is recorded
  // only after the change has succeeded.
  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.user.name || req.user.email,
    action: 'cancel_parcel',
    targetType: 'parcel',
    targetId: parcel._id,
    targetName: parcel.trackingId,
    details: { reason },
  })

  const updated = await Parcel.findById(parcel._id)
  return res.status(200).json({ ...updated.toObject(), currentStatus: 'cancelled' })
})

/**
 * PATCH /api/parcels/:id/reassign
 * Admin only: hand a parcel's active leg to another approved rider.
 *
 * `riderId` is accepted as either the rider's Firebase uid or their
 * application id, because the two admin screens that feed this endpoint carry
 * different identifiers. The rider's uid is what `assignedRider` stores.
 */
export const adminReassignParcel = asyncHandler(async (req, res) => {
  const { id } = req.params
  const { riderId } = req.body

  if (!riderId) {
    return res.status(400).json({ error: 'riderId is required' })
  }

  const parcel = await Parcel.findById(id)
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  const rider = await RiderApplication.findOne({
    status: 'approved',
    $or: [
      { userId: String(riderId) },
      ...(mongoose.isValidObjectId(riderId) ? [{ _id: riderId }] : []),
    ],
  })

  if (!rider) {
    return res.status(404).json({ error: 'Approved rider not found' })
  }

  const previousUid = parcel.assignedRider?.uid || null
  if (previousUid && previousUid !== rider.userId) {
    await RiderApplication.updateOne(
      { userId: previousUid, currentParcel: parcel._id },
      { $set: { currentParcel: null } }
    )
  }

  /**
   * The handover has to carry the same money and cash fields the rider's own
   * accept writes. The payout snapshot is what the delivery screen, the
   * completion credit and settlement all read; a reassigned parcel without
   * one kept the schema default of all zeroes, so the rider who dropped it at
   * the godown was credited ৳0.
   */
  const [payment, rateCard, completedToday] = await Promise.all([
    Payment.findOne({ parcel: parcel._id }).select('method amount').lean(),
    getRiderRateCard(),
    countCompletedDeliveries(rider.userId, startOfDay()),
  ])
  const { leg, distanceKm, payoutSnapshot, cod } = buildAssignmentFields({
    parcel,
    uid: rider.userId,
    name: rider.name,
    payment,
    rateCard,
    completedToday,
  })

  const assignment = {
    assignedRider: { uid: rider.userId, name: rider.name },
    assignedAt: new Date(),
    acceptedAt: parcel.acceptedAt || new Date(),
    distanceKm,
  }

  // Never overwrite money the previous rider already finished the work for:
  // `earnedAt` marks the leg as settled history, and repricing it here would
  // erase the amount from their earnings. A live leg is the new rider's work
  // and gets a fresh snapshot priced to the current card - which also replaces
  // a stale snapshot that still names the previous rider.
  if (!parcel.riderPayouts?.[leg]?.earnedAt) {
    assignment[`riderPayouts.${leg}`] = payoutSnapshot
    // Cash already declared collected belongs to the rider holding it; the
    // fresh `cod` (which clears `collectedAt`) is only safe before that.
    if (!parcel.cod?.collectedAt) assignment.cod = cod
  }

  await Parcel.updateOne({ _id: parcel._id }, { $set: assignment })
  await RiderApplication.updateOne(
    { userId: rider.userId },
    { $set: { currentParcel: parcel._id } }
  )

  await Tracking.create({
    parcel: parcel._id,
    trackingId: parcel.trackingId,
    status: 'assigned',
    message: `Reassigned to ${rider.name} by admin`,
    eventTime: new Date(),
    updatedBy: { uid: req.user.uid, name: req.adminUser?.name || 'Swift Ship' },
  })

  // The activity log is the audit trail of who did what, so it is recorded
  // only after the change has succeeded.
  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.user.name || req.user.email,
    action: 'reassign_parcel',
    targetType: 'parcel',
    targetId: parcel._id,
    targetName: parcel.trackingId,
    details: { riderId },
  })

  const updated = await Parcel.findById(parcel._id)
  const { status: currentStatus } = await getLatestEvent(parcel._id)
  return res.status(200).json({ ...updated.toObject(), currentStatus })
})