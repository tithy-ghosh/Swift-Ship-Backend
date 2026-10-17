import User from '../models/user.model.js'
import Parcel from '../models/parcel.model.js'
import Payment from '../models/payment.model.js'
import Tracking from '../models/tracking.model.js'

/**
 * Data definitions and query builders for GET /api/admin/export/:resource.
 *
 * One builder per resource returns `{ columns, rows, total }`, where `columns`
 * is an ordered `{ key, label }` list (the label is what the admin sees as a
 * spreadsheet header) and `rows` is already flattened - the controller only
 * decides between CSV and JSON. Keeping the query work here means a new
 * export target is one entry in `EXPORT_BUILDERS`, not a new route.
 */

/**
 * Hard ceiling on one export. An unbounded find() would hold every document
 * in memory at once and could stall the single node process on a mature
 * dataset; 10k rows is far more than any reconciliation an operator does by
 * hand, and a truncation is reported rather than silently dropped.
 */
export const MAX_EXPORT_ROWS = 10000

const USER_ROLES = ['customer', 'rider', 'merchant', 'admin']
const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'cancelled', 'refunded']
const PAYOUT_STATUSES = ['pending', 'paid']

/** Builds the users export. Optional `role` narrows to one role. */
const buildUsersExport = async ({ role } = {}) => {
  const match = USER_ROLES.includes(role) ? { role } : {}

  const [users, total] = await Promise.all([
    User.find(match).sort({ createdAt: -1 }).limit(MAX_EXPORT_ROWS).lean(),
    User.countDocuments(match),
  ])

  const columns = [
    { key: 'uid', label: 'User ID' },
    { key: 'name', label: 'Name' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'role', label: 'Role' },
    { key: 'address', label: 'Address' },
    { key: 'provider', label: 'Sign-in provider' },
    { key: 'lastLoginAt', label: 'Last login' },
    { key: 'createdAt', label: 'Registered at' },
  ]

  const rows = users.map((user) => ({
    uid: user.uid,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    address: user.address,
    provider: user.provider,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  }))

  return { columns, rows, total }
}

/**
 * Builds the parcels export, one row per parcel.
 *
 * A parcel has no status column of its own - the newest Tracking event is the
 * status - so the latest status is resolved with the same aggregate-then-join
 * pattern the admin parcel list uses. Optional `status` narrows to parcels
 * whose *latest* event has that status, which is the only reading of "show me
 * the delivered ones" that means what an operator expects.
 */
const buildParcelsExport = async ({ status } = {}) => {
  const match = {}

  const parcels = await Parcel.find(match)
    .sort({ createdAt: -1 })
    .limit(MAX_EXPORT_ROWS)
    .lean()
  const parcelIds = parcels.map(({ _id }) => _id)

  const statusRows = await Tracking.aggregate([
    { $match: { parcel: { $in: parcelIds } } },
    { $sort: { eventTime: -1, createdAt: -1 } },
    { $group: { _id: '$parcel', currentStatus: { $first: '$status' } } },
  ])
  const statusByParcel = new Map(statusRows.map((row) => [String(row._id), row.currentStatus]))

  const columns = [
    { key: 'trackingId', label: 'Tracking ID' },
    { key: 'status', label: 'Status' },
    { key: 'type', label: 'Type' },
    { key: 'title', label: 'Title' },
    { key: 'weight', label: 'Weight (kg)' },
    { key: 'senderName', label: 'Sender' },
    { key: 'senderContact', label: 'Sender contact' },
    { key: 'senderServiceCenter', label: 'Sender district' },
    { key: 'senderRegion', label: 'Sender region' },
    { key: 'receiverName', label: 'Receiver' },
    { key: 'receiverContact', label: 'Receiver contact' },
    { key: 'receiverServiceCenter', label: 'Receiver district' },
    { key: 'receiverRegion', label: 'Receiver region' },
    { key: 'deliveryZone', label: 'Delivery zone' },
    { key: 'deliveryCost', label: 'Delivery cost (BDT)' },
    { key: 'leg', label: 'Leg' },
    { key: 'assignedRiderName', label: 'Assigned rider' },
    { key: 'assignedRiderUid', label: 'Rider ID' },
    { key: 'cancellationReason', label: 'Cancellation reason' },
    { key: 'createdAt', label: 'Created at' },
    { key: 'acceptedAt', label: 'Accepted at' },
  ]

  const toRow = (parcel) => ({
    trackingId: parcel.trackingId,
    status: statusByParcel.get(String(parcel._id)) || 'pending',
    type: parcel.type,
    title: parcel.title,
    weight: parcel.weight,
    senderName: parcel.senderName,
    senderContact: parcel.senderContact,
    senderServiceCenter: parcel.senderServiceCenter,
    senderRegion: parcel.senderRegion,
    receiverName: parcel.receiverName,
    receiverContact: parcel.receiverContact,
    receiverServiceCenter: parcel.receiverServiceCenter,
    receiverRegion: parcel.receiverRegion,
    deliveryZone: parcel.deliveryZone,
    deliveryCost: parcel.deliveryCost,
    leg: parcel.leg || 'same-district',
    assignedRiderName: parcel.assignedRider?.name || '',
    assignedRiderUid: parcel.assignedRider?.uid || '',
    cancellationReason: parcel.cancellation?.reason || '',
    createdAt: parcel.createdAt,
    acceptedAt: parcel.acceptedAt,
  })

  const allRows = parcels.map(toRow)
  const rows = status
    ? allRows.filter((row) => row.status === status).slice(0, MAX_EXPORT_ROWS)
    : allRows.slice(0, MAX_EXPORT_ROWS)

  return { columns, rows, total: status ? allRows.filter((row) => row.status === status).length : parcels.length }
}

/** Builds the payments export. Optional `status` narrows to one status. */
const buildPaymentsExport = async ({ status } = {}) => {
  const match = PAYMENT_STATUSES.includes(status) ? { status } : {}

  const [payments, total] = await Promise.all([
    Payment.find(match).sort({ createdAt: -1 }).limit(MAX_EXPORT_ROWS).lean(),
    Payment.countDocuments(match),
  ])

  const columns = [
    { key: 'trackingId', label: 'Tracking ID' },
    { key: 'method', label: 'Method' },
    { key: 'status', label: 'Status' },
    { key: 'transactionId', label: 'Transaction ID' },
    { key: 'amount', label: 'Amount (BDT)' },
    { key: 'paidAmount', label: 'Paid amount (BDT)' },
    { key: 'paidAt', label: 'Paid at' },
    { key: 'refundedAt', label: 'Refunded at' },
    { key: 'refundReason', label: 'Refund reason' },
    { key: 'createdAt', label: 'Created at' },
  ]

  const rows = payments.map((payment) => ({
    trackingId: payment.trackingId,
    method: payment.method,
    status: payment.status,
    transactionId: payment.transactionId || '',
    amount: payment.amount,
    paidAmount: payment.paidAmount ?? '',
    paidAt: payment.paidAt,
    refundedAt: payment.refundedAt,
    refundReason: payment.refundReason,
    createdAt: payment.createdAt,
  }))

  return { columns, rows, total }
}

/**
 * Flattens one parcel's earned legs to settlement rows.
 *
 * A payout is per leg, not per parcel: a cross-district delivery pays a
 * pickup rider and a delivery rider separately, and collapsing them would
 * make it impossible to reconcile which of the two has been paid. Only legs
 * that were actually finished (`earnedAt`) and have an owner are exported -
 * a payout snapshot written at accept but never earned is not money yet.
 *
 * COD columns belong to the delivery-side rider only; the pickup rider never
 * holds the customer's cash, so those cells stay blank on their row.
 */
const payoutRowsForParcel = (parcel) => {
  const rows = []

  for (const leg of ['pickup', 'delivery']) {
    const payout = parcel.riderPayouts?.[leg]
    if (!payout?.earnedAt || !payout.rider?.uid) continue

    const holdsCash = leg === 'delivery'

    rows.push({
      trackingId: parcel.trackingId,
      leg,
      riderName: payout.rider.name || '',
      riderUid: payout.rider.uid,
      baseFare: payout.baseFare || 0,
      perKmRate: payout.perKmRate || 0,
      distanceKm: payout.distanceKm ?? '',
      bonus: payout.bonus || 0,
      total: payout.total || 0,
      // The 40-60 split, with a pre-split fallback: legs snapshotted before
      // the split existed recorded the whole total as the rider's money.
      riderShare: payout.riderShare || payout.total || 0,
      companyShare: payout.companyShare || 0,
      payoutStatus: payout.status,
      earnedAt: payout.earnedAt,
      paidAt: payout.paidAt,
      batchId: payout.batchId || '',
      codRequired: holdsCash ? (parcel.cod?.required ? 'yes' : 'no') : '',
      codAmount: holdsCash ? parcel.cod?.amount || 0 : '',
      codDepositStatus: holdsCash ? parcel.cod?.depositStatus || 'not_required' : '',
      codHandedOverAt: holdsCash ? parcel.cod?.handedOverAt : '',
      codDepositedAt: holdsCash ? parcel.cod?.depositedAt : '',
    })
  }

  return rows
}

/**
 * Builds the rider-payouts export. Optional `status` narrows to 'pending' or
 * 'paid'; anything else (including 'all') exports every earned leg.
 */
const buildPayoutsExport = async ({ status } = {}) => {
  const legFilter = PAYOUT_STATUSES.includes(status) ? status : null

  // Newest activity first and bounded: a settlement rewrites the parcel, so
  // `updatedAt` orders the worklist by recency without a per-leg sort, and the
  // limit keeps a mature dataset from loading every parcel at once.
  const parcels = await Parcel.find({
    $or: [
      { 'riderPayouts.pickup.earnedAt': { $ne: null } },
      { 'riderPayouts.delivery.earnedAt': { $ne: null } },
    ],
  })
    .sort({ updatedAt: -1 })
    .limit(MAX_EXPORT_ROWS)
    .lean()

  const allRows = parcels
    .flatMap(payoutRowsForParcel)
    .filter((row) => !legFilter || row.payoutStatus === legFilter)
    .sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt))

  const columns = [
    { key: 'trackingId', label: 'Tracking ID' },
    { key: 'leg', label: 'Leg' },
    { key: 'riderName', label: 'Rider' },
    { key: 'riderUid', label: 'Rider ID' },
    { key: 'baseFare', label: 'Base fare (BDT)' },
    { key: 'perKmRate', label: 'Per-km rate (BDT)' },
    { key: 'distanceKm', label: 'Distance (km)' },
    { key: 'bonus', label: 'Bonus (BDT)' },
    { key: 'total', label: 'Total (BDT)' },
    { key: 'riderShare', label: 'Rider share (BDT)' },
    { key: 'companyShare', label: 'Company share (BDT)' },
    { key: 'payoutStatus', label: 'Payout status' },
    { key: 'earnedAt', label: 'Earned at' },
    { key: 'paidAt', label: 'Paid at' },
    { key: 'batchId', label: 'Batch ID' },
    { key: 'codRequired', label: 'COD required' },
    { key: 'codAmount', label: 'COD amount (BDT)' },
    { key: 'codDepositStatus', label: 'COD deposit status' },
    { key: 'codHandedOverAt', label: 'COD handed over at' },
    { key: 'codDepositedAt', label: 'COD deposited at' },
  ]

  return { columns, rows: allRows.slice(0, MAX_EXPORT_ROWS), total: allRows.length }
}

const EXPORT_BUILDERS = {
  users: buildUsersExport,
  parcels: buildParcelsExport,
  payments: buildPaymentsExport,
  payouts: buildPayoutsExport,
}

/** The resource names GET /api/admin/export/:resource accepts. */
export const EXPORT_RESOURCES = Object.keys(EXPORT_BUILDERS)

/**
 * Singular log target names for each resource, matching the values the
 * activity-log screen filters by (`user`, `parcel`, ...), so an export entry
 * groups with the rest of that entity's history.
 */
export const EXPORT_TARGET_TYPES = {
  users: 'user',
  parcels: 'parcel',
  payments: 'payment',
  payouts: 'payout',
}

/**
 * Runs the builder for `resource`.
 *
 * @param {string} resource 'users' | 'parcels' | 'payments' | 'payouts'
 * @param {{role?: string, status?: string}} filters query-string filters
 * @returns {Promise<{columns: Array<{key: string, label: string}>,
 *                    rows: Array<Record<string, unknown>>, total: number}>}
 * @throws {Error} with `.statusCode = 404` for an unknown resource
 */
export const buildExportData = async (resource, filters = {}) => {
  const builder = EXPORT_BUILDERS[resource]
  if (!builder) {
    const error = new Error(
      `Unknown export resource '${resource}'. Try one of: ${EXPORT_RESOURCES.join(', ')}`
    )
    error.statusCode = 404
    throw error
  }

  return builder(filters)
}
