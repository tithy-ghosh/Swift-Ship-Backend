import User from '../models/user.model.js';
import Parcel from '../models/parcel.model.js'; 
import Payment from '../models/payment.model.js'; 
import RiderApplication from '../models/riderApplication.model.js';
import MerchantApplication from '../models/merchantApplication.model.js';
import Tracking from '../models/tracking.model.js';
import ActivityLog from '../models/activityLog.model.js';
import RiderRating from '../models/riderRating.model.js';
import { logAdminAction } from '../services/activity-log.service.js';
import Announcement from '../models/announcement.model.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { canConfirmCodDeposit } from '../services/delivery-flow.service.js';
import {
  resolveWindow,
  normalizeGranularity,
  percentChange,
  pointChange,
  summarizeDurations,
  bucketStarts,
  dateGroupExpression,
  buildSeries,
  BUSINESS_TIMEZONE,
} from '../services/analytics.service.js';
import { summarizeDeliveryBuckets } from '../services/performance.service.js';
import { buildExportData, EXPORT_TARGET_TYPES } from '../services/export.service.js';
import { csvBody, csvFilename } from '../utils/csv.js';

export const getAdminStats = asyncHandler(async (req, res) => {
  // 1. Count Users
  const totalUsers = await User.countDocuments();

  // 2. Count Rider Applications
  const pendingRiders = await RiderApplication.countDocuments({ status: 'pending' });
  const activeRiders = await RiderApplication.countDocuments({ status: 'approved' });

  // 2b. Count Merchant Applications
  const pendingMerchants = await MerchantApplication.countDocuments({ status: 'pending' });
  const activeMerchants = await MerchantApplication.countDocuments({ status: 'approved' });

  // 3. Count Parcels
  //
  // The Parcel document has no `status` field: a parcel's current state is the
  // newest event in the append-only Tracking log, so counting `Parcel.status`
  // (as this used to) always returned 0. Collapse each parcel to its latest
  // event, then tally how many sit in each status.
  const totalParcels = await Parcel.countDocuments();
  const statusBuckets = await Tracking.aggregate([
    { $sort: { eventTime: -1, createdAt: -1 } },
    { $group: { _id: '$parcel', status: { $first: '$status' } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const statusCounts = statusBuckets.reduce((acc, { _id, count }) => {
    acc[_id] = count;
    return acc;
  }, {});
  const trackedParcels = statusBuckets.reduce((sum, { count }) => sum + count, 0);
  // A parcel with no tracking events at all (legacy rows, or a create that
  // failed halfway) is treated as pending rather than silently dropped.
  const pendingParcels =
    (statusCounts.pending || 0) + Math.max(totalParcels - trackedParcels, 0);
  const deliveredParcels = statusCounts.delivered || 0;

  // 4. Calculate Total Revenue 
 
  const revenueData = await Payment.aggregate([
    { $match: { status: 'paid' } }, // Change 'paid' to whatever your success status is (e.g., 'success', 'completed')
    { $group: { _id: null, totalRevenue: { $sum: '$amount' } } } // Change 'amount' to your actual price field name
  ]);
  
  const totalRevenue = revenueData.length > 0 ? revenueData[0].totalRevenue : 0;

  res.status(200).json({
    totalUsers,
    pendingRiders,
    activeRiders,
    pendingMerchants,
    activeMerchants,
    totalParcels,
    pendingParcels,
    deliveredParcels,
    totalRevenue,
  });
});

/**
 * PATCH /api/admin/rider-payouts/:parcelId
 *
 * Marks a rider's settlement state for one leg of one delivery. This is the
 * write side of the earnings screen's "pending / paid" column.
 *
 * Settlement is per leg because a cross-district parcel pays two different
 * riders two different amounts: `riderPayouts.pickup` is leg 1's money,
 * `riderPayouts.delivery` is leg 2's (and a same-district parcel's only) money.
 * Omitting `leg` settles the delivery leg, which is the common case.
 *
 * The two flags are independent because the rider's earnings and the cash they
 * are holding are separate movements of money: paying a rider 120 does not
 * mean the 850 of COD they collected has also been handed over.
 *
 * `codDepositStatus: 'deposited'` is a confirmation, not a claim: it is
 * rejected until the rider has recorded the handover (`cod.handedOverAt`),
 * so the admin is always confirming something the rider declared.
 *
 * @param {string} [req.body.leg] 'pickup' | 'delivery'. Defaults to 'delivery'.
 * @param {string} payoutStatus 'pending' | 'paid'
 * @param {string} codDepositStatus 'not_required' | 'pending' | 'deposited'
 * @param {string} batchId Groups settlements settled in one run.
 */
export const updateRiderPayout = asyncHandler(async (req, res) => {
  const { parcelId } = req.params;
  const { leg = 'delivery', payoutStatus, codDepositStatus, batchId = '' } = req.body;

  if (leg !== 'pickup' && leg !== 'delivery') {
    return res.status(400).json({ error: "leg must be 'pickup' or 'delivery'" });
  }
  if (!payoutStatus && !codDepositStatus) {
    return res.status(400).json({ error: 'payoutStatus or codDepositStatus is required' });
  }

  const parcel = await Parcel.findById(parcelId);
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' });
  }

  const payout = parcel.riderPayouts?.[leg];
  if (!payout?.total) {
    return res.status(409).json({ error: `This parcel has no recorded ${leg} leg payout.` });
  }
  if (!payout.earnedAt) {
    // The snapshot is written the moment a rider accepts, so `total` exists
    // long before anybody has done the work. Paying on `total` alone would
    // settle a delivery that is still in progress.
    return res
      .status(409)
      .json({ error: `The ${leg} leg has not been completed yet, so it cannot be settled.` });
  }

  const update = {};
  if (payoutStatus) update[`riderPayouts.${leg}.status`] = payoutStatus;
  if (batchId) update[`riderPayouts.${leg}.batchId`] = batchId;
  if (payoutStatus === 'paid') update[`riderPayouts.${leg}.paidAt`] = new Date();
  if (codDepositStatus) {
    if (
      codDepositStatus === 'deposited' &&
      parcel.cod?.depositStatus !== 'deposited' &&
      !canConfirmCodDeposit(parcel.cod)
    ) {
      // The admin confirms a handover the rider declared; without it there is
      // nothing on record to confirm, and the button would be a blind mark.
      // Re-confirming an already-deposited parcel stays a harmless no-op, so
      // parcels deposited before this rule existed keep settling as before.
      return res.status(409).json({
        error: 'The rider has not marked this cash as handed over yet.',
      });
    }
    update['cod.depositStatus'] = codDepositStatus;
    if (codDepositStatus === 'deposited') update['cod.depositedAt'] = new Date();
  }

  const updated = await Parcel.findByIdAndUpdate(parcelId, { $set: update }, { new: true })
    .select('trackingId riderPayouts cod assignedRider leg');

  // The activity log is the audit trail of who did what, so it is recorded
  // only after the change has succeeded.
  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.user.name || req.user.email,
    action: 'settle_payout',
    targetType: 'parcel',
    targetId: parcelId,
    targetName: updated.trackingId,
    details: { leg, payoutStatus, batchId },
  });

  res.status(200).json(updated);
});

/**
 * GET /api/admin/rider-payouts?status=pending|paid|all
 *
 * The settlement worklist: one row per leg that has money to move, newest
 * first. `status=pending` (the default) is the to-pay queue; `all` also brings
 * back settled rows so an admin can audit a batch later.
 */
export const listRiderPayouts = asyncHandler(async (req, res) => {
  const { status = 'pending' } = req.query;

  const match = {};
  if (status === 'pending' || status === 'paid') {
    match.$or = [
      { 'riderPayouts.pickup.status': status },
      { 'riderPayouts.delivery.status': status },
    ];
    // COD confirmation must be reachable from the default view even when the
    // payout leg is already settled: without this, a paid leg with cash still
    // undeposited only appears under `paid` or `all`, and the admin has no
    // idea there is cash waiting to be confirmed.
    if (status === 'pending') {
      match.$or.push({ 'cod.depositStatus': 'pending' });
    }
  }

  const parcels = await Parcel.find(match)
    .sort({ updatedAt: -1 })
    .limit(200)
    .select(
      'trackingId leg riderPayouts cod assignedRider receiverName receiverServiceCenter updatedAt'
    )
    .lean();

  const rows = [];
  for (const parcel of parcels) {
    for (const leg of ['pickup', 'delivery']) {
      const payout = parcel.riderPayouts?.[leg];
      // A leg nobody ever claimed has no total and is not a settlement row.
      if (!payout?.total) continue;
      // Written on completion, not on accept: an in-progress leg has a quoted
      // figure but nothing is owed yet, so it must not appear as a debt.
      if (!payout.earnedAt) continue;
      if (status !== 'all' && payout.status !== status) {
        // In the pending view, a settled leg with undeposited cash still
        // belongs: the row is what carries the COD confirmation button.
        const codAwaitingConfirm =
          status === 'pending' &&
          leg === 'delivery' &&
          parcel.cod?.depositStatus === 'pending';
        if (!codAwaitingConfirm) continue;
      }

      rows.push({
        parcelId: String(parcel._id),
        trackingId: parcel.trackingId,
        leg,
        riderName: payout.rider?.name || parcel.assignedRider?.name || '',
        // What the admin actually pays out is the rider's 40% share. The
        // fallback covers legs snapshotted before the split existed - those
        // were recorded with the whole total as the rider's money.
        amount: payout.riderShare || payout.total,
        total: payout.total,
        companyShare: payout.companyShare || 0,
        payoutStatus: payout.status,
        batchId: payout.batchId || '',
        paidAt: payout.paidAt || null,
        earnedAt: payout.earnedAt || null,
        // COD rides along on the delivery-side row only: a pickup-leg rider
        // never holds the customer's cash.
        cod:
          leg === 'delivery'
            ? {
                amount: parcel.cod?.amount || 0,
                depositStatus: parcel.cod?.depositStatus || 'not_required',
                handedOverAt: parcel.cod?.handedOverAt || null,
              }
            : null,
        destination: parcel.receiverServiceCenter,
        updatedAt: parcel.updatedAt,
      });
    }
  }

  rows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.status(200).json({ rows });
});

/**
 * PATCH /api/admin/parcels/:parcelId/handoff
 *
 * The staff-side middle step of the hub model: the parcel has physically
 * arrived at the destination godown and is now ready for a delivery rider.
 *
 * Flips the parcel from leg 'pickup' to leg 'delivery' and clears the claim so
 * the delivery job appears in the destination district's feed. Leg 1's rider
 * and payout stay untouched - they are recorded on the pickup leg snapshot and
 * in the tracking log, not on `assignedRider`.
 */
export const handoffParcel = asyncHandler(async (req, res) => {
  const { parcelId } = req.params;

  const parcel = await Parcel.findById(parcelId);
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' });
  }
  if (parcel.leg !== 'pickup') {
    return res
      .status(409)
      .json({ error: 'Only a cross-district parcel awaiting handoff can be handed off.' });
  }

  const updated = await Parcel.findOneAndUpdate(
    { _id: parcel._id, leg: 'pickup' },
    {
      $set: {
        leg: 'delivery',
        assignedRider: { uid: null, name: '' },
        assignedAt: null,
        acceptedAt: null,
      },
    },
    { new: true }
  ).select('trackingId leg assignedRider');

  // A timeline note, not a status change: the parcel is still parked at a
  // godown until a rider picks it up. Keeps the customer's view honest.
  await Tracking.create({
    parcel: updated._id,
    trackingId: updated.trackingId,
    status: 'at-godown',
    location: parcel.receiverServiceCenter,
    message: 'Ready for delivery at destination godown',
    eventTime: new Date(),
    updatedBy: { uid: req.user.uid, name: 'Swift Ship' },
  });

  // The activity log is the audit trail of who did what, so it is recorded
  // only after the change has succeeded.
  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.user.name || req.user.email,
    action: 'handoff_parcel',
    targetType: 'parcel',
    targetId: parcel._id,
    targetName: parcel.trackingId,
    details: { fromLeg: 'pickup', toLeg: 'delivery' },
  });

  res.status(200).json(updated);
});

/** PATCH /api/admin/rider-documents/:userId/:documentType
 *
 * Admin verifies or rejects a rider's document.
 *
 * @param {string} req.params.userId - Firebase UID of the rider
 * @param {string} req.params.documentType - nid, license, or bikeRegistration
 * @param {string} req.body.action - 'verify' or 'reject'
 * @param {string} [req.body.reason] - rejection reason
 */
export const verifyRiderDocument = asyncHandler(async (req, res) => {
  const { userId, documentType } = req.params
  const { action, reason } = req.body

  const validTypes = ['nid', 'license', 'bikeRegistration']
  if (!validTypes.includes(documentType)) {
    return res.status(400).json({ error: 'Invalid document type.' })
  }
  if (action !== 'verify' && action !== 'reject') {
    return res.status(400).json({ error: "Action must be 'verify' or 'reject'." })
  }

  const rider = await RiderApplication.findOne({ userId })
  if (!rider) {
    return res.status(404).json({ error: 'No rider application found.' })
  }

  const update = {
    [`documents.${documentType}.status`]: action === 'verify' ? 'verified' : 'rejected',
  }

  if (action === 'reject') {
    update[`documents.${documentType}.rejectedAt`] = new Date()
    update[`documents.${documentType}.rejectedReason`] = reason || ''
  }

  const updated = await RiderApplication.findByIdAndUpdate(rider._id, { $set: update }, { new: true })

  // Recompute overall documentsStatus
  const docs = updated.documents
  const allVerified = Object.values(docs).every((d) => d.status === 'verified')
  const anyRejected = Object.values(docs).some((d) => d.status === 'rejected')

  let documentsStatus = 'pending'
  if (allVerified) documentsStatus = 'verified'
  else if (anyRejected) documentsStatus = 'rejected'

  await RiderApplication.findByIdAndUpdate(updated._id, { $set: { documentsStatus } })

  // The activity log is the audit trail of who did what, so it is recorded
  // only after the change has succeeded.
  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.user.name || req.user.email,
    action: action === 'verify' ? 'verify_document' : 'reject_document',
    targetType: 'document',
    targetId: `${userId}/${documentType}`,
    targetName: `${rider.name} - ${documentType}`,
    details: {
      documentType,
      status: action === 'verify' ? 'verified' : 'rejected',
      reason,
    },
  })

  res.json({
    documentType,
    status: action === 'verify' ? 'verified' : 'rejected',
    documentsStatus,
  })
})

/** The canonical order a parcel moves through, used to sort the funnel so it
 * reads top-to-bottom rather than by whatever count happens to be largest. */
const FUNNEL_ORDER = [
  'pending',
  'assigned',
  'picked-up',
  'in-transit',
  'out-for-delivery',
  'at-godown',
  'delivered',
  'cancelled',
]

const WEEKDAY_LABELS = { 1: 'Sun', 2: 'Mon', 3: 'Tue', 4: 'Wed', 5: 'Thu', 6: 'Fri', 7: 'Sat' }

/** Timeline of one completed delivery: the delivered event minus the moment the
 * rider accepted it. The `$match` drops parcels with no `acceptedAt` or a
 * negative span (data written before the field existed). */
const deliveryDurationPipeline = (range) => [
  { $match: { status: 'delivered', eventTime: range } },
  { $group: { _id: '$parcel', deliveredAt: { $min: '$eventTime' } } },
  {
    $lookup: {
      from: 'parcels',
      localField: '_id',
      foreignField: '_id',
      as: 'parcel',
    },
  },
  { $unwind: '$parcel' },
  { $project: { durationMs: { $subtract: ['$deliveredAt', '$parcel.acceptedAt'] } } },
  { $match: { durationMs: { $gte: 0 } } },
  { $group: { _id: null, durations: { $push: '$durationMs' } } },
]

/** GET /api/admin/analytics?range=7d|30d|90d&granularity=day|week
 *
 * Aggregated admin analytics: window-scoped KPIs with previous-period deltas,
 * day/week time-series, the delivery funnel, SLA (avg/median/p90 delivery
 * time), cancellations by reason, a rider leaderboard, peak activity and the
 * current payout/COD liability.
 *
 * Every date window is Dhaka-local, so "today" is the operator's today rather
 * than the server's. The current window ends at "now" and therefore includes a
 * partial day; the previous window is the equally long block of full days
 * immediately before it, which is what makes the deltas comparable.
 */
export const getAdminAnalytics = asyncHandler(async (req, res) => {
  const { range = '30d', granularity: rawGranularity = 'day' } = req.query
  const granularity = normalizeGranularity(rawGranularity)
  const now = new Date()

  const { days, start, end, prevStart, prevEnd } = resolveWindow(range, now)
  const currentRange = { $gte: start, $lt: end }
  const previousRange = { $gte: prevStart, $lt: prevEnd }

  const starts = bucketStarts(days, granularity, now)
  const dateKey = (field) => dateGroupExpression(field, granularity, BUSINESS_TIMEZONE)

  // A payment belongs to the day the money moved (paidAt) or, while a gateway
  // callback is still outstanding, the day it was created.
  const paymentDate = { $ifNull: ['$paidAt', '$createdAt'] }
  // paidAt-in-range OR unpaid-in-range. paidAt is never earlier than createdAt
  // and never in the future, so this pair is exact without an upper-bound OR.
  const paymentInRange = (range2) => ({
    $or: [{ paidAt: range2 }, { paidAt: null, createdAt: range2 }],
  })
  const revenueAmount = { $sum: { $ifNull: ['$paidAmount', '$amount'] } }

  // ---- time-series ----
  const [
    revenueRows,
    deliveryRows,
    userRows,
    userRoleRows,
    cancellationRows,
  ] = await Promise.all([
    Payment.aggregate([
      { $match: { status: { $in: ['paid', 'pending'] }, ...paymentInRange(currentRange) } },
      { $group: { _id: dateKey(paymentDate), revenue: revenueAmount, count: { $sum: 1 } } },
    ]),
    Tracking.aggregate([
      { $match: { status: 'delivered', eventTime: currentRange } },
      { $group: { _id: dateKey('$eventTime'), count: { $sum: 1 } } },
    ]),
    User.aggregate([
      { $match: { createdAt: currentRange } },
      { $group: { _id: dateKey('$createdAt'), count: { $sum: 1 } } },
    ]),
    User.aggregate([
      { $match: { createdAt: currentRange } },
      {
        $group: {
          _id: { date: dateKey('$createdAt'), role: '$role' },
          count: { $sum: 1 },
        },
      },
    ]),
    Tracking.aggregate([
      { $match: { status: 'cancelled', eventTime: currentRange } },
      { $group: { _id: dateKey('$eventTime'), count: { $sum: 1 } } },
    ]),
  ])

  // ---- overall snapshots (lifetime, where a range makes no sense) ----
  const [
    pendingPayments,
    totalParcels,
    statusCounts,
    activeRiders,
    totalRiders,
    totalCustomers,
    totalMerchants,
    totalUsers,
  ] = await Promise.all([
    Payment.countDocuments({ status: 'pending' }),
    Parcel.countDocuments(),
    Tracking.aggregate([
      { $sort: { eventTime: -1, createdAt: -1 } },
      { $group: { _id: '$parcel', latestStatus: { $first: '$status' } } },
      { $group: { _id: '$latestStatus', count: { $sum: 1 } } },
    ]),
    RiderApplication.countDocuments({ status: 'approved', isOnline: true }),
    User.countDocuments({ role: 'rider' }),
    User.countDocuments({ role: 'customer' }),
    User.countDocuments({ role: 'merchant' }),
    User.countDocuments(),
  ])

  // ---- window-scoped period metrics (current + previous) ----
  const [
    currentRevenueStats,
    previousRevenueStats,
    deliveredCurrent,
    deliveredPrevious,
    cancelledCurrent,
    cancelledPrevious,
    newParcelsCurrent,
    newParcelsPrevious,
    newUsersCurrent,
    newUsersPrevious,
    currentDurations,
    previousDurations,
  ] = await Promise.all([
    Payment.aggregate([
      { $match: { status: { $in: ['paid', 'pending'] }, ...paymentInRange(currentRange) } },
      { $group: { _id: null, revenue: revenueAmount, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: { status: { $in: ['paid', 'pending'] }, ...paymentInRange(previousRange) } },
      { $group: { _id: null, revenue: revenueAmount, count: { $sum: 1 } } },
    ]),
    Tracking.countDocuments({ status: 'delivered', eventTime: currentRange }),
    Tracking.countDocuments({ status: 'delivered', eventTime: previousRange }),
    Tracking.countDocuments({ status: 'cancelled', eventTime: currentRange }),
    Tracking.countDocuments({ status: 'cancelled', eventTime: previousRange }),
    Parcel.countDocuments({ createdAt: currentRange }),
    Parcel.countDocuments({ createdAt: previousRange }),
    User.countDocuments({ createdAt: currentRange }),
    User.countDocuments({ createdAt: previousRange }),
    Tracking.aggregate(deliveryDurationPipeline(currentRange)),
    Tracking.aggregate(deliveryDurationPipeline(previousRange)),
  ])

  // ---- breakdowns ----
  const [
    paymentMethodRows,
    districtRows,
    reasonRows,
    leaderboardRows,
    peakHourRows,
    peakWeekdayRows,
    payoutSnapshotRows,
    codSnapshotRows,
  ] = await Promise.all([
    Payment.aggregate([
      { $match: { status: { $in: ['paid', 'pending'] }, ...paymentInRange(currentRange) } },
      { $group: { _id: '$method', count: { $sum: 1 }, amount: revenueAmount } },
      { $sort: { amount: -1 } },
    ]),
    // Destination volume: where parcels created this window are headed.
    Parcel.aggregate([
      { $match: { createdAt: currentRange } },
      { $group: { _id: '$receiverServiceCenter', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    // Windowed by the tracking cancel event (always present); the reason is
    // read off the parcel, and pre-field cancellations fall back to Unspecified.
    Tracking.aggregate([
      { $match: { status: 'cancelled', eventTime: currentRange } },
      { $group: { _id: '$parcel' } },
      {
        $lookup: {
          from: 'parcels',
          localField: '_id',
          foreignField: '_id',
          as: 'parcel',
        },
      },
      { $unwind: '$parcel' },
      {
        $group: {
          _id: {
            $cond: [
              {
                $or: [
                  { $eq: ['$parcel.cancellation.reason', ''] },
                  { $eq: ['$parcel.cancellation.reason', null] },
                ],
              },
              'Unspecified',
              '$parcel.cancellation.reason',
            ],
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    // Riders ranked by legs they actually finished (earnedAt) in the window.
    Parcel.aggregate([
      {
        $match: {
          $or: [
            { 'riderPayouts.pickup.earnedAt': currentRange },
            { 'riderPayouts.delivery.earnedAt': currentRange },
          ],
        },
      },
      {
        $project: {
          legs: [
            {
              uid: '$riderPayouts.pickup.rider.uid',
              name: '$riderPayouts.pickup.rider.name',
              // The rider's own money is the 40% share. The fallback covers
              // legs snapshotted before the split existed, when the whole
              // total was paid to the rider.
              total: { $ifNull: ['$riderPayouts.pickup.riderShare', '$riderPayouts.pickup.total'] },
              earnedAt: '$riderPayouts.pickup.earnedAt',
            },
            {
              uid: '$riderPayouts.delivery.rider.uid',
              name: '$riderPayouts.delivery.rider.name',
              total: {
                $ifNull: ['$riderPayouts.delivery.riderShare', '$riderPayouts.delivery.total'],
              },
              earnedAt: '$riderPayouts.delivery.earnedAt',
            },
          ],
        },
      },
      { $unwind: '$legs' },
      { $match: { 'legs.earnedAt': currentRange, 'legs.uid': { $nin: ['', null] } } },
      {
        $group: {
          _id: '$legs.uid',
          name: { $last: '$legs.name' },
          deliveries: { $sum: 1 },
          earnings: { $sum: '$legs.total' },
        },
      },
      { $sort: { deliveries: -1, earnings: -1 } },
      { $limit: 10 },
    ]),
    Tracking.aggregate([
      { $match: { status: 'delivered', eventTime: currentRange } },
      {
        $group: {
          _id: { $hour: { date: '$eventTime', timezone: BUSINESS_TIMEZONE } },
          count: { $sum: 1 },
        },
      },
    ]),
    Tracking.aggregate([
      { $match: { status: 'delivered', eventTime: currentRange } },
      {
        $group: {
          _id: { $dayOfWeek: { date: '$eventTime', timezone: BUSINESS_TIMEZONE } },
          count: { $sum: 1 },
        },
      },
    ]),
    // Liability right now, not a range figure: what the business owes riders and
    // the cash riders are holding.
    Parcel.aggregate([
      {
        $group: {
          _id: null,
          pendingPayoutAmount: {
            $sum: {
              $add: [
                {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$riderPayouts.pickup.status', 'pending'] },
                        { $ne: ['$riderPayouts.pickup.earnedAt', null] },
                      ],
                    },
                    // Liability is the rider's 40% share. The fallback keeps
                    // pre-split legs counted at their full recorded total.
                    { $ifNull: ['$riderPayouts.pickup.riderShare', '$riderPayouts.pickup.total'] },
                    0,
                  ],
                },
                {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$riderPayouts.delivery.status', 'pending'] },
                        { $ne: ['$riderPayouts.delivery.earnedAt', null] },
                      ],
                    },
                    {
                      $ifNull: ['$riderPayouts.delivery.riderShare', '$riderPayouts.delivery.total'],
                    },
                    0,
                  ],
                },
              ],
            },
          },
          pendingPayoutCount: {
            $sum: {
              $add: [
                {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$riderPayouts.pickup.status', 'pending'] },
                        { $ne: ['$riderPayouts.pickup.earnedAt', null] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
                {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$riderPayouts.delivery.status', 'pending'] },
                        { $ne: ['$riderPayouts.delivery.earnedAt', null] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              ],
            },
          },
          paidPayoutAmount: {
            $sum: {
              $add: [
                {
                  $cond: [
                    { $eq: ['$riderPayouts.pickup.status', 'paid'] },
                    { $ifNull: ['$riderPayouts.pickup.riderShare', '$riderPayouts.pickup.total'] },
                    0,
                  ],
                },
                {
                  $cond: [
                    { $eq: ['$riderPayouts.delivery.status', 'paid'] },
                    {
                      $ifNull: ['$riderPayouts.delivery.riderShare', '$riderPayouts.delivery.total'],
                    },
                    0,
                  ],
                },
              ],
            },
          },
        },
      },
    ]),
    Parcel.aggregate([
      {
        $group: {
          _id: null,
          codHeldAmount: {
            $sum: { $cond: [{ $eq: ['$cod.depositStatus', 'pending'] }, '$cod.amount', 0] },
          },
          codHeldCount: {
            $sum: { $cond: [{ $eq: ['$cod.depositStatus', 'pending'] }, 1, 0] },
          },
          codDepositedAmount: {
            $sum: { $cond: [{ $eq: ['$cod.depositStatus', 'deposited'] }, '$cod.amount', 0] },
          },
        },
      },
    ]),
  ])

  // ---- assemble series ----
  const roleRows = (role) =>
    userRoleRows
      .filter((row) => row._id.role === role)
      .map((row) => ({ _id: row._id.date, count: row.count }))

  const byRole = {
    customer: buildSeries(roleRows('customer'), starts, { defaults: { count: 0 } }),
    rider: buildSeries(roleRows('rider'), starts, { defaults: { count: 0 } }),
    merchant: buildSeries(roleRows('merchant'), starts, { defaults: { count: 0 } }),
  }

  const series = {
    revenue: buildSeries(revenueRows, starts, { defaults: { revenue: 0, count: 0 } }),
    deliveries: buildSeries(deliveryRows, starts, { defaults: { count: 0 } }),
    newUsers: buildSeries(userRows, starts, { defaults: { count: 0 } }),
    newUsersByRole: byRole.customer.map((point, index) => ({
      date: point.date,
      customer: point.count,
      rider: byRole.rider[index].count,
      merchant: byRole.merchant[index].count,
    })),
    cancellations: buildSeries(cancellationRows, starts, { defaults: { count: 0 } }),
  }

  // ---- status funnel ----
  const statusMap = {}
  statusCounts.forEach((bucket) => {
    statusMap[bucket._id] = bucket.count
  })
  const totalTracked = Object.values(statusMap).reduce((sum, count) => sum + count, 0)
  // A parcel with no tracking events at all is pending, not missing.
  const untracked = Math.max(totalParcels - totalTracked, 0)
  if (untracked > 0) statusMap.pending = (statusMap.pending || 0) + untracked

  const orderedStatuses = [
    ...FUNNEL_ORDER.filter((status) => statusMap[status] !== undefined),
    ...Object.keys(statusMap).filter((status) => !FUNNEL_ORDER.includes(status)),
  ]
  const statusDistribution = orderedStatuses.map((status) => ({
    status,
    count: statusMap[status],
  }))

  const deliveredLifetime = statusMap.delivered || 0
  const cancelledLifetime = statusMap.cancelled || 0

  // ---- period + deltas ----
  const currentSla = summarizeDurations(currentDurations[0]?.durations || [])
  const previousSla = summarizeDurations(previousDurations[0]?.durations || [])

  const concludedCurrent = deliveredCurrent + cancelledCurrent
  const concludedPrevious = deliveredPrevious + cancelledPrevious

  const period = {
    revenue: currentRevenueStats[0]?.revenue || 0,
    payments: currentRevenueStats[0]?.count || 0,
    delivered: deliveredCurrent,
    cancelled: cancelledCurrent,
    newParcels: newParcelsCurrent,
    newUsers: newUsersCurrent,
    successRate: concludedCurrent > 0 ? (deliveredCurrent / concludedCurrent) * 100 : 0,
    cancellationRate:
      concludedCurrent > 0 ? (cancelledCurrent / concludedCurrent) * 100 : 0,
    avgDeliveryMinutes: currentSla.avgMinutes,
  }

  const previous = {
    revenue: previousRevenueStats[0]?.revenue || 0,
    payments: previousRevenueStats[0]?.count || 0,
    delivered: deliveredPrevious,
    cancelled: cancelledPrevious,
    newParcels: newParcelsPrevious,
    newUsers: newUsersPrevious,
    successRate:
      concludedPrevious > 0 ? (deliveredPrevious / concludedPrevious) * 100 : 0,
    cancellationRate:
      concludedPrevious > 0 ? (cancelledPrevious / concludedPrevious) * 100 : 0,
    avgDeliveryMinutes: previousSla.avgMinutes,
  }

  const delta = {
    revenuePct: percentChange(period.revenue, previous.revenue),
    paymentsPct: percentChange(period.payments, previous.payments),
    deliveredPct: percentChange(period.delivered, previous.delivered),
    cancelledPct: percentChange(period.cancelled, previous.cancelled),
    newParcelsPct: percentChange(period.newParcels, previous.newParcels),
    newUsersPct: percentChange(period.newUsers, previous.newUsers),
    successRatePts: pointChange(period.successRate, previous.successRate),
    cancellationRatePts: pointChange(period.cancellationRate, previous.cancellationRate),
    avgDeliveryMinutesPct: percentChange(
      period.avgDeliveryMinutes,
      previous.avgDeliveryMinutes
    ),
  }

  // ---- leaderboard enrichment ----
  const riderIds = leaderboardRows.map((row) => row._id)
  const [riderApps, riderRatings] = riderIds.length
    ? await Promise.all([
        RiderApplication.find({ userId: { $in: riderIds } })
          .select('userId name isOnline')
          .lean(),
        RiderRating.aggregate([
          { $match: { riderId: { $in: riderIds } } },
          { $group: { _id: '$riderId', rating: { $avg: '$rating' }, ratings: { $sum: 1 } } },
        ]),
      ])
    : [[], []]

  const appById = new Map(riderApps.map((app) => [app.userId, app]))
  const ratingById = new Map(riderRatings.map((row) => [row._id, row]))

  const riderLeaderboard = leaderboardRows.map((row) => {
    const app = appById.get(row._id)
    const rating = ratingById.get(row._id)

    return {
      uid: row._id,
      name: row.name || app?.name || 'Rider',
      deliveries: row.deliveries,
      earnings: Math.round(row.earnings || 0),
      rating: rating ? Math.round(rating.rating * 10) / 10 : null,
      ratings: rating?.ratings || 0,
      isOnline: Boolean(app?.isOnline),
    }
  })

  // ---- peak activity ----
  const hourMap = new Map(peakHourRows.map((row) => [row._id, row.count]))
  const byHour = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: hourMap.get(hour) || 0,
  }))

  const weekdayMap = new Map(peakWeekdayRows.map((row) => [row._id, row.count]))
  const byWeekday = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    weekday: WEEKDAY_LABELS[day],
    count: weekdayMap.get(day) || 0,
  }))

  const payoutSnapshot = payoutSnapshotRows[0] || {}
  const codSnapshot = codSnapshotRows[0] || {}

  res.json({
    range,
    days,
    granularity,
    timezone: BUSINESS_TIMEZONE,
    generatedAt: now,
    overview: {
      totalRevenue: period.revenue,
      totalPaid: period.payments,
      pendingPayments,
      totalParcels,
      totalTracked,
      deliveredCount: deliveredLifetime,
      cancelledCount: cancelledLifetime,
      successRate:
        totalTracked > 0 ? (deliveredLifetime / totalTracked) * 100 : 0,
      cancellationRate:
        totalTracked > 0 ? (cancelledLifetime / totalTracked) * 100 : 0,
      activeRiders,
      totalRiders,
      totalCustomers,
      totalMerchants,
      totalUsers,
      avgDeliveryMinutes: currentSla.avgMinutes,
    },
    period,
    previous,
    delta,
    series,
    statusDistribution,
    sla: currentSla,
    cancellationsByReason: reasonRows.map((row) => ({
      reason: row._id,
      count: row.count,
    })),
    riderLeaderboard,
    peakTimes: { byHour, byWeekday },
    financials: {
      pendingPayoutAmount: payoutSnapshot.pendingPayoutAmount || 0,
      pendingPayoutCount: payoutSnapshot.pendingPayoutCount || 0,
      paidPayoutAmount: payoutSnapshot.paidPayoutAmount || 0,
      codHeldAmount: codSnapshot.codHeldAmount || 0,
      codHeldCount: codSnapshot.codHeldCount || 0,
      codDepositedAmount: codSnapshot.codDepositedAmount || 0,
    },
    paymentMethods: paymentMethodRows,
    topDistricts: districtRows,
  })
})

/** GET /api/admin/performance?range=7d|30d|90d
 *
 * Delivery-performance detail for the performance page, deeper than the
 * analytics summary: per-rider SLA (average/median delivery time, on-time
 * rate), the distribution of delivery durations across fixed buckets, rider
 * volume and earnings, rider-caused cancellations and a success-rate summary.
 *
 * A "delivery time" is the final leg only - the delivering rider's accept to
 * the delivered event. For a cross-district parcel that is godown-to-door,
 * which is the span the delivering rider controls; for a same-district parcel
 * it is the whole route. Every window is Dhaka-local, exactly like analytics,
 * so the two pages never disagree about what "last 7 days" means.
 */
export const getAdminPerformance = asyncHandler(async (req, res) => {
  const { range = '30d' } = req.query
  const now = new Date()

  const { days, start, end } = resolveWindow(range, now)
  const currentRange = { $gte: start, $lt: end }

  // Every completed delivery in the window with its duration and the rider
  // who delivered it. The `$match` on durationMs drops parcels with no
  // acceptedAt (pre-field data) or a negative span.
  const durationRows = await Tracking.aggregate([
    { $match: { status: 'delivered', eventTime: currentRange } },
    { $group: { _id: '$parcel', deliveredAt: { $min: '$eventTime' } } },
    {
      $lookup: {
        from: 'parcels',
        localField: '_id',
        foreignField: '_id',
        as: 'parcel',
      },
    },
    { $unwind: '$parcel' },
    {
      $project: {
        durationMs: { $subtract: ['$deliveredAt', '$parcel.acceptedAt'] },
        riderUid: '$parcel.riderPayouts.delivery.rider.uid',
        riderName: '$parcel.riderPayouts.delivery.rider.name',
      },
    },
    { $match: { durationMs: { $gte: 0 } } },
  ])

  // Legs actually finished in the window, per rider and leg. This is the
  // volume/earnings half of the report; the duration half above only covers
  // delivery legs.
  const legRows = await Parcel.aggregate([
    {
      $match: {
        $or: [
          { 'riderPayouts.pickup.earnedAt': currentRange },
          { 'riderPayouts.delivery.earnedAt': currentRange },
        ],
      },
    },
    {
      $project: {
        legs: [
          {
            leg: 'pickup',
            uid: '$riderPayouts.pickup.rider.uid',
            name: '$riderPayouts.pickup.rider.name',
            // Rider-side money is the 40% share, with a pre-split fallback.
            total: { $ifNull: ['$riderPayouts.pickup.riderShare', '$riderPayouts.pickup.total'] },
            earnedAt: '$riderPayouts.pickup.earnedAt',
          },
          {
            leg: 'delivery',
            uid: '$riderPayouts.delivery.rider.uid',
            name: '$riderPayouts.delivery.rider.name',
            total: {
              $ifNull: ['$riderPayouts.delivery.riderShare', '$riderPayouts.delivery.total'],
            },
            earnedAt: '$riderPayouts.delivery.earnedAt',
          },
        ],
      },
    },
    { $unwind: '$legs' },
    { $match: { 'legs.earnedAt': currentRange, 'legs.uid': { $nin: ['', null] } } },
    {
      $group: {
        _id: { uid: '$legs.uid', leg: '$legs.leg' },
        name: { $last: '$legs.name' },
        legs: { $sum: 1 },
        earnings: { $sum: '$legs.total' },
      },
    },
  ])

  // Parcels cancelled by the rider themselves (stopped-by-rider path).
  const riderCancellationRows = await Parcel.aggregate([
    {
      $match: {
        'cancellation.cancelledAt': currentRange,
        'cancellation.cancelledBy.role': 'rider',
      },
    },
    {
      $group: {
        _id: '$cancellation.cancelledBy.uid',
        name: { $last: '$cancellation.cancelledBy.name' },
        count: { $sum: 1 },
      },
    },
  ])

  // Concluded volume for the rates, plus the reason breakdown shared with the
  // analytics delivery tab (same windowing and "Unspecified" fallback).
  const [deliveredCount, cancelledCount, reasonRows] = await Promise.all([
    Tracking.countDocuments({ status: 'delivered', eventTime: currentRange }),
    Tracking.countDocuments({ status: 'cancelled', eventTime: currentRange }),
    Tracking.aggregate([
      { $match: { status: 'cancelled', eventTime: currentRange } },
      { $group: { _id: '$parcel' } },
      {
        $lookup: {
          from: 'parcels',
          localField: '_id',
          foreignField: '_id',
          as: 'parcel',
        },
      },
      { $unwind: '$parcel' },
      {
        $group: {
          _id: {
            $cond: [
              {
                $or: [
                  { $eq: ['$parcel.cancellation.reason', ''] },
                  { $eq: ['$parcel.cancellation.reason', null] },
                ],
              },
              'Unspecified',
              '$parcel.cancellation.reason',
            ],
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
  ])

  // ---- per-rider assembly ----
  const riderMap = new Map()
  const ensureRider = (uid, name) => {
    if (!uid) return null

    let entry = riderMap.get(uid)
    if (!entry) {
      entry = {
        uid,
        name: '',
        deliveries: 0,
        pickups: 0,
        earnings: 0,
        cancelled: 0,
        durations: [],
      }
      riderMap.set(uid, entry)
    }
    if (name && !entry.name) entry.name = name

    return entry
  }

  legRows.forEach((row) => {
    const entry = ensureRider(row._id.uid, row.name)
    if (!entry) return

    if (row._id.leg === 'delivery') entry.deliveries = row.legs
    else entry.pickups = row.legs
    entry.earnings += row.earnings || 0
  })

  durationRows.forEach((row) => {
    const entry = ensureRider(row.riderUid, row.riderName)
    if (entry) entry.durations.push(row.durationMs)
  })

  riderCancellationRows.forEach((row) => {
    const entry = ensureRider(row._id, row.name)
    if (entry) entry.cancelled = row.count
  })

  // Enrichment: online status and lifetime rating, same sources as the
  // analytics leaderboard.
  const riderIds = [...riderMap.keys()]
  const [riderApps, riderRatings] = riderIds.length
    ? await Promise.all([
        RiderApplication.find({ userId: { $in: riderIds } })
          .select('userId name isOnline')
          .lean(),
        RiderRating.aggregate([
          { $match: { riderId: { $in: riderIds } } },
          { $group: { _id: '$riderId', rating: { $avg: '$rating' }, ratings: { $sum: 1 } } },
        ]),
      ])
    : [[], []]

  const appById = new Map(riderApps.map((app) => [app.userId, app]))
  const ratingById = new Map(riderRatings.map((row) => [row._id, row]))

  const riders = riderIds
    .map((uid) => {
      const entry = riderMap.get(uid)
      const app = appById.get(uid)
      const rating = ratingById.get(uid)
      const sla = summarizeDurations(entry.durations)
      const buckets = summarizeDeliveryBuckets(entry.durations)

      return {
        uid,
        name: entry.name || app?.name || 'Rider',
        isOnline: Boolean(app?.isOnline),
        rating: rating ? Math.round(rating.rating * 10) / 10 : null,
        ratings: rating?.ratings || 0,
        deliveries: entry.deliveries,
        pickups: entry.pickups,
        earnings: Math.round(entry.earnings),
        avgDeliveryMinutes: sla.avgMinutes,
        medianDeliveryMinutes: sla.medianMinutes,
        onTimeRate: buckets.onTimeRate,
        samples: sla.sampleSize,
        cancelled: entry.cancelled,
      }
    })
    .sort((a, b) => b.deliveries - a.deliveries || b.earnings - a.earnings)

  // ---- overall summary ----
  const durations = durationRows.map((row) => row.durationMs)
  const overallSla = summarizeDurations(durations)
  const overallBuckets = summarizeDeliveryBuckets(durations)

  const concluded = deliveredCount + cancelledCount

  res.json({
    range,
    days,
    timezone: BUSINESS_TIMEZONE,
    generatedAt: now,
    summary: {
      delivered: deliveredCount,
      cancelled: cancelledCount,
      successRate: concluded > 0 ? (deliveredCount / concluded) * 100 : 0,
      cancellationRate: concluded > 0 ? (cancelledCount / concluded) * 100 : 0,
      sla: overallSla,
      onTimeRate: overallBuckets.onTimeRate,
      onTimeMinutes: overallBuckets.onTimeMinutes,
    },
    durationBuckets: overallBuckets.buckets,
    riders,
    cancellationsByReason: reasonRows.map((row) => ({
      reason: row._id,
      count: row.count,
    })),
  })
})

/** GET /api/admin/export/:resource?format=csv|json
 *
 * Downloads admin data as a spreadsheet-ready CSV (default) or JSON.
 *
 * Supported resources: users, parcels, payments, payouts. Optional filters
 * (role for users, status for all others) narrow the export to what the admin
 * was looking at, so the file matches the screen instead of the whole table.
 *
 * Exports are audited: every download appends an `export_data` entry to the
 * activity log with the row count and the filters used, because shipping the
 * customer database to a laptop is exactly the kind of action an audit trail
 * is for.
 */
export const exportAdminData = asyncHandler(async (req, res) => {
  const { resource } = req.params
  const { format = 'csv', role, status } = req.query

  const { columns, rows, total } = await buildExportData(resource, { role, status })

  // Recorded before the response is sent: a download that fails after this
  // point still exported the data, so the trail must keep it.
  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.adminUser?.name || req.user.name || 'Admin',
    action: 'export_data',
    targetType: EXPORT_TARGET_TYPES[resource] || resource,
    details: {
      resource,
      format: format === 'json' ? 'json' : 'csv',
      rows: rows.length,
      total,
      truncated: total > rows.length,
      filters: { role: role || null, status: status || null },
    },
  })

  if (format === 'json') {
    return res.json({
      resource,
      exportedAt: new Date(),
      total,
      truncated: total > rows.length,
      rows,
    })
  }

  const filename = csvFilename(resource)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(csvBody(columns, rows))
})

/** GET /api/admin/activity-log?action=&targetType=&limit=50&offset=0
 *
 * Returns the admin activity log - a chronological record of administrative
 * actions (approve rider, settle payout, verify document, etc.) with actor,
 * target, and timestamp details.
 *
 * Query params:
 *   action     - filter by action type (e.g. 'approve_rider')
 *   targetType - filter by target type (e.g. 'rider', 'parcel', 'payment')
 *   search     - free text matched against actor, action and target
 *   limit      - max records to return (default 50, max 200)
 *   offset     - number of records to skip (default 0)
 */
export const getAdminActivityLog = asyncHandler(async (req, res) => {
  const { action, targetType, search, limit = '50', offset = '0' } = req.query

  const match = {}
  if (action) match.action = action
  if (targetType) match.targetType = targetType
  if (search) {
    const term = String(search).trim()
    // Escape the term so an admin cannot inject regex metacharacters, then
    // treat it as a literal substring across the searchable fields.
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    match.$or = [
      { actorName: pattern },
      { actorUid: pattern },
      { action: pattern },
      { targetType: pattern },
      { targetName: pattern },
    ]
  }

  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
  const offsetNum = Math.max(parseInt(offset, 10) || 0, 0)

  const [logs, total] = await Promise.all([
    ActivityLog.find(match)
      .sort({ createdAt: -1 })
      .skip(offsetNum)
      .limit(limitNum)
      .lean(),
    ActivityLog.countDocuments(match),
  ])

  res.json({
    logs: logs.map((log) => ({
      id: String(log._id),
      actorUid: log.actorUid,
      actorName: log.actorName,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      targetName: log.targetName,
      details: log.details,
      createdAt: log.createdAt,
    })),
    total,
    limit: limitNum,
    offset: offsetNum,
  })
})

/** POST /api/admin/announcements
 *
 * Create a new announcement for riders, customers, merchants, or all users.
 *
 * @param {string} req.body.title
 * @param {string} req.body.body
 * @param {'rider'|'customer'|'merchant'|'all'} req.body.target
 * @param {string} [req.body.expiresAt] - ISO date string, optional
 */
export const createAnnouncement = asyncHandler(async (req, res) => {
  const { title, body, target, expiresAt } = req.body

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' })
  }
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Body is required' })
  }
  if (!target || !['rider', 'customer', 'merchant', 'all'].includes(target)) {
    return res.status(400).json({
      error: "target must be 'rider', 'customer', 'merchant', or 'all'",
    })
  }

  const announcement = await Announcement.create({
    title: title.trim(),
    body: body.trim(),
    target,
    isActive: true,
    expiresAt: expiresAt || null,
    createdBy: req.user.uid,
    createdByName: req.adminUser?.name || req.user.name || 'Admin',
  })

  res.status(201).json({
    id: String(announcement._id),
    title: announcement.title,
    body: announcement.body,
    target: announcement.target,
    isActive: announcement.isActive,
    expiresAt: announcement.expiresAt,
    createdBy: announcement.createdBy,
    createdByName: announcement.createdByName,
    createdAt: announcement.createdAt,
  })
})

/** GET /api/admin/announcements?target=&isActive=&limit=&offset=
 *
 * List announcements with optional filtering.
 */
export const getAdminAnnouncements = asyncHandler(async (req, res) => {
  const { target, isActive, limit = '50', offset = '0' } = req.query

  const match = {}
  if (target) match.target = target
  if (isActive !== undefined) match.isActive = isActive === 'true'

  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
  const offsetNum = Math.max(parseInt(offset, 10) || 0, 0)

  const [announcements, total] = await Promise.all([
    Announcement.find(match)
      .sort({ createdAt: -1 })
      .skip(offsetNum)
      .limit(limitNum)
      .lean(),
    Announcement.countDocuments(match),
  ])

  res.json({
    announcements: announcements.map((a) => ({
      id: String(a._id),
      title: a.title,
      body: a.body,
      target: a.target,
      isActive: a.isActive,
      expiresAt: a.expiresAt,
      createdBy: a.createdBy,
      createdByName: a.createdByName,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
    total,
    limit: limitNum,
    offset: offsetNum,
  })
})

/** PATCH /api/admin/announcements/:id
 *
 * Update an announcement's title, body, target, isActive, or expiresAt.
 */
export const updateAnnouncement = asyncHandler(async (req, res) => {
  const { id } = req.params
  const { title, body, target, isActive, expiresAt } = req.body

  const announcement = await Announcement.findById(id)
  if (!announcement) {
    return res.status(404).json({ error: 'Announcement not found' })
  }

  if (title !== undefined) announcement.title = title.trim()
  if (body !== undefined) announcement.body = body.trim()
  if (target !== undefined) {
    if (!['rider', 'customer', 'merchant', 'all'].includes(target)) {
      return res.status(400).json({
        error: "target must be 'rider', 'customer', 'merchant', or 'all'",
      })
    }
    announcement.target = target
  }
  if (isActive !== undefined) announcement.isActive = isActive
  if (expiresAt !== undefined) announcement.expiresAt = expiresAt || null

  await announcement.save()

  res.json({
    id: String(announcement._id),
    title: announcement.title,
    body: announcement.body,
    target: announcement.target,
    isActive: announcement.isActive,
    expiresAt: announcement.expiresAt,
    createdBy: announcement.createdBy,
    createdByName: announcement.createdByName,
    createdAt: announcement.createdAt,
    updatedAt: announcement.updatedAt,
  })
})

/** DELETE /api/admin/announcements/:id
 *
 * Delete an announcement.
 */
export const deleteAnnouncement = asyncHandler(async (req, res) => {
  const { id } = req.params

  const announcement = await Announcement.findByIdAndDelete(id)
  if (!announcement) {
    return res.status(404).json({ error: 'Announcement not found' })
  }

  res.json({ message: 'Announcement deleted' })
})

/** GET /api/announcements/active?target=
 *
 * Public endpoint for riders/customers to fetch active announcements.
 * No authentication required.
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
