import mongoose from 'mongoose'
import Parcel from '../models/parcel.model.js'
import Payment from '../models/payment.model.js'
import Tracking, { TRACKING_STATUSES } from '../models/tracking.model.js'
import MerchantRemittance from '../models/merchantRemittance.model.js'

/**
 * Merchant-facing parcel queries and summary/export logic.
 *
 * The merchant workspace reads the same collections the customer dashboard
 * does, but it must never see rider-facing internals (`riderPayouts`, payout
 * batches, deposit bookkeeping beyond the COD block). Everything a merchant
 * API returns therefore goes through `serializeMerchantParcel`, and the
 * raw joins live here so the controller stays a thin HTTP layer.
 *
 * A parcel has no status column of its own - the newest Tracking event is the
 * status - so the joins mirror `listMyParcels`: aggregate the latest event per
 * parcel, then map it back in JS.
 */

/** Hard ceiling on one merchant export (mirrors the admin export cap). */
export const MAX_MERCHANT_EXPORT_ROWS = 10000

/** Escapes a search term so it is matched literally, not as a regex. */
const escapeRegex = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Flattens one joined parcel into the merchant-safe shape.
 *
 * `canEditReceiver`/`canCancel` answer the server-enforced rule directly
 * ("pending and unassigned") so the shipments table can hide actions that the
 * backend would reject with a 409.
 *
 * @param {object} parcel lean parcel document
 * @param {{payment?: object|null, currentStatus?: string|null, lastEventAt?: Date|null,
 *          hasActiveReturn?: boolean}} [runtime]
 */
export const serializeMerchantParcel = (
  parcel,
  { payment = null, currentStatus = null, lastEventAt = null, hasActiveReturn = false } = {}
) => {
  const status = currentStatus || 'pending'
  const isCod = payment?.method === 'cod'
  const editable = !parcel.assignedRider?.uid && status === 'pending'

  return {
    _id: String(parcel._id),
    trackingId: parcel.trackingId,
    type: parcel.type,
    title: parcel.title || '',
    weight: parcel.weight || 0,
    deliveryZone: parcel.deliveryZone,
    senderName: parcel.senderName,
    senderContact: parcel.senderContact,
    senderRegion: parcel.senderRegion,
    senderServiceCenter: parcel.senderServiceCenter,
    senderAddress: parcel.senderAddress || '',
    pickupInstruction: parcel.pickupInstruction || '',
    receiverName: parcel.receiverName,
    receiverContact: parcel.receiverContact,
    receiverRegion: parcel.receiverRegion,
    receiverServiceCenter: parcel.receiverServiceCenter,
    receiverAddress: parcel.receiverAddress || '',
    deliveryInstruction: parcel.deliveryInstruction || '',
    deliveryCost: parcel.deliveryCost,
    status,
    /**
     * When the newest tracking event happened. For a delivered parcel this is
     * the delivery moment (cash collection writes no tracking event), which is
     * what the COD ledger reports as the delivered date.
     */
    lastStatusAt: lastEventAt || null,
    canEditReceiver: editable,
    canCancel: editable,
    /**
     * COD here is the customer-facing fact ("cash must change hands on
     * delivery"). The rider deposit bookkeeping is surfaced only as its
     * current state, never as payout math.
     */
    cod: {
      required: isCod,
      amount: isCod ? parcel.cod?.amount || payment?.amount || 0 : 0,
      collectedAt: parcel.cod?.collectedAt || null,
      depositStatus: isCod ? parcel.cod?.depositStatus || 'pending' : 'not_required',
      depositedAt: parcel.cod?.depositedAt || null,
    },
    cancellation: parcel.cancellation?.cancelledAt
      ? {
          reason: parcel.cancellation.reason,
          cancelledAt: parcel.cancellation.cancelledAt,
        }
      : null,
    /**
     * Reverse pickups (Feature 8). `direction` drives the "Return" chip and
     * `returnOf` links back to the parcel being reversed. `canRequestReturn`
     * answers the server rule ("delivered, not itself a return, no active
     * return yet") so the table only renders a working action.
     */
    direction: parcel.direction === 'return' ? 'return' : 'forward',
    returnOf: parcel.returnOf?.trackingId
      ? {
          trackingId: parcel.returnOf.trackingId,
          parcelId: parcel.returnOf.parcelId ? String(parcel.returnOf.parcelId) : null,
          reason: parcel.returnOf.reason || '',
        }
      : null,
    canRequestReturn:
      status === 'delivered' && parcel.direction !== 'return' && !hasActiveReturn,
    createdAt: parcel.createdAt,
    updatedAt: parcel.updatedAt,
  }
}

/**
 * Joins payments and the latest tracking status onto lean parcels, then
 * serializes each one. The maps are keyed by parcel id because `parcel` on a
 * Payment is an ObjectId while `_id` on a Tracking aggregate row is too.
 *
 * A third read resolves which originals already have an active (uncancelled)
 * return, so the serializer can rule out a duplicate "Request return" before
 * the button renders - the create endpoint enforces the same rule again.
 */
const attachRuntimeState = async (parcels) => {
  const parcelIds = parcels.map(({ _id }) => _id)

  const [payments, statusRows, activeReturns] = await Promise.all([
    Payment.find({ parcel: { $in: parcelIds } }).lean(),
    Tracking.aggregate([
      { $match: { parcel: { $in: parcelIds } } },
      { $sort: { eventTime: -1, createdAt: -1 } },
      {
        $group: {
          _id: '$parcel',
          currentStatus: { $first: '$status' },
          lastEventAt: { $first: '$eventTime' },
        },
      },
    ]),
    Parcel.find({
      'returnOf.parcelId': { $in: parcelIds },
      'cancellation.cancelledAt': null,
    })
      .select('returnOf.parcelId')
      .lean(),
  ])

  const paymentByParcel = new Map(payments.map((item) => [String(item.parcel), item]))
  const statusByParcel = new Map(
    statusRows.map((row) => [
      String(row._id),
      { status: row.currentStatus, lastEventAt: row.lastEventAt },
    ])
  )
  const originalsWithActiveReturn = new Set(
    activeReturns.map((item) => String(item.returnOf?.parcelId))
  )

  return parcels.map((parcel) => {
    const runtime = statusByParcel.get(String(parcel._id)) || null
    const parcelId = String(parcel._id)

    return serializeMerchantParcel(parcel, {
      payment: paymentByParcel.get(parcelId) || null,
      currentStatus: runtime?.status || null,
      lastEventAt: runtime?.lastEventAt || null,
      hasActiveReturn: originalsWithActiveReturn.has(parcelId),
    })
  })
}

/**
 * Lists one merchant's own parcels, newest first, optionally narrowed by a
 * free-text term matched against tracking id, receiver name and phone, and/or
 * by travel direction (`return` powers the returns page; `forward` is the
 * inverse, since pre-return documents carry no `direction`).
 *
 * @param {string} uid Firebase uid of the merchant
 * @param {{search?: string, direction?: string}} [filters]
 */
export const listMerchantParcels = async (uid, { search = '', direction = '' } = {}) => {
  const match = { 'createdBy.uid': uid }
  const term = String(search || '').trim()

  if (direction === 'return') {
    match.direction = 'return'
  } else if (direction === 'forward') {
    match.direction = { $ne: 'return' }
  }

  if (term) {
    const pattern = new RegExp(escapeRegex(term), 'i')
    match.$or = [
      { trackingId: pattern },
      { receiverName: pattern },
      { receiverContact: pattern },
    ]
  }

  const parcels = await Parcel.find(match).sort({ createdAt: -1 }).lean()
  return attachRuntimeState(parcels)
}

/**
 * Finds one merchant-owned parcel by id. Returns `null` for a malformed id,
 * an unknown parcel, or one that belongs to another merchant - the three cases
 * are deliberately indistinguishable so the endpoint cannot be used to probe
 * for ids.
 */
export const findMerchantParcelById = async (uid, id) => {
  if (!mongoose.isValidObjectId(id)) return null

  const parcel = await Parcel.findOne({ _id: id, 'createdBy.uid': uid }).lean()
  if (!parcel) return null

  const [serialized] = await attachRuntimeState([parcel])
  return serialized
}

/**
 * Builds the workspace summary from already-joined parcels.
 *
 * Pure on purpose: the status counts, COD totals and the recent slice are the
 * numbers the merchant home screen shows, and the only interesting logic is
 * here, so this is what the unit tests exercise.
 *
 * COD accounting treats a parcel as collected once `cod.collectedAt` is set.
 * The amount shown before pickup is the amount the rider must carry - the
 * payment amount, because COD in this system settles the delivery cost.
 *
 * @param {Array<object>} parcels serialized merchant parcels
 * @param {{recentLimit?: number}} [options]
 */
export const buildMerchantSummary = (parcels, { recentLimit = 5 } = {}) => {
  const byStatus = Object.fromEntries(TRACKING_STATUSES.map((status) => [status, 0]))
  const cod = {
    requiredCount: 0,
    amountTotal: 0,
    collectedCount: 0,
    collectedAmount: 0,
    pendingAmount: 0,
  }

  for (const parcel of parcels) {
    const status = parcel.status || 'pending'
    byStatus[status] = (byStatus[status] || 0) + 1

    if (parcel.cod?.required) {
      const amount = parcel.cod.amount || 0
      cod.requiredCount += 1
      cod.amountTotal += amount

      if (parcel.cod.collectedAt) {
        cod.collectedCount += 1
        cod.collectedAmount += amount
      } else {
        cod.pendingAmount += amount
      }
    }
  }

  const recent = parcels.slice(0, recentLimit).map((parcel) => ({
    _id: parcel._id,
    trackingId: parcel.trackingId,
    receiverName: parcel.receiverName,
    receiverServiceCenter: parcel.receiverServiceCenter,
    receiverRegion: parcel.receiverRegion,
    status: parcel.status,
    type: parcel.type,
    deliveryCost: parcel.deliveryCost,
    codAmount: parcel.cod?.required ? parcel.cod.amount || 0 : 0,
    createdAt: parcel.createdAt,
  }))

  return { total: parcels.length, byStatus, cod, recent }
}

/** Columns for the merchant parcel export, in spreadsheet order. */
const EXPORT_COLUMNS = [
  { key: 'trackingId', label: 'Tracking ID' },
  { key: 'returnOfTrackingId', label: 'Return of' },
  { key: 'status', label: 'Status' },
  { key: 'type', label: 'Type' },
  { key: 'title', label: 'Title' },
  { key: 'weight', label: 'Weight (kg)' },
  { key: 'receiverName', label: 'Receiver' },
  { key: 'receiverContact', label: 'Receiver contact' },
  { key: 'receiverServiceCenter', label: 'Receiver district' },
  { key: 'receiverRegion', label: 'Receiver region' },
  { key: 'deliveryCost', label: 'Delivery cost (BDT)' },
  { key: 'codRequired', label: 'COD required' },
  { key: 'codAmount', label: 'COD amount (BDT)' },
  { key: 'codCollectedAt', label: 'COD collected at' },
  { key: 'codDepositStatus', label: 'COD deposit status' },
  { key: 'cancellationReason', label: 'Cancellation reason' },
  { key: 'createdAt', label: 'Created at' },
]

/**
 * Builds the merchant parcel export. Optional `status` narrows to parcels
 * whose latest tracking event has that status, matching the shipments tab the
 * merchant exported from.
 *
 * @param {string} uid Firebase uid of the merchant
 * @param {{status?: string}} [filters]
 */
export const buildMerchantParcelsExport = async (uid, { status } = {}) => {
  const parcels = await listMerchantParcels(uid)
  const filtered = TRACKING_STATUSES.includes(status)
    ? parcels.filter((parcel) => parcel.status === status)
    : parcels

  const rows = filtered.slice(0, MAX_MERCHANT_EXPORT_ROWS).map((parcel) => ({
    trackingId: parcel.trackingId,
    returnOfTrackingId: parcel.returnOf?.trackingId || '',
    status: parcel.status,
    type: parcel.type,
    title: parcel.title,
    weight: parcel.weight,
    receiverName: parcel.receiverName,
    receiverContact: parcel.receiverContact,
    receiverServiceCenter: parcel.receiverServiceCenter,
    receiverRegion: parcel.receiverRegion,
    deliveryCost: parcel.deliveryCost,
    codRequired: parcel.cod.required ? 'yes' : 'no',
    codAmount: parcel.cod.required ? parcel.cod.amount : '',
    codCollectedAt: parcel.cod.collectedAt || '',
    codDepositStatus: parcel.cod.depositStatus,
    cancellationReason: parcel.cancellation?.reason || '',
    createdAt: parcel.createdAt,
  }))

  return { columns: EXPORT_COLUMNS, rows, total: filtered.length }
}

// ---- COD ledger & remittances ----

/**
 * Derived settlement state per ledger row.
 *
 * `not_collected` -> `awaiting_remittance` -> (batch status) `pending` /
 * `processing` / `paid`. The batch statuses come straight off
 * `MerchantRemittance`, so a merchant sees exactly what SwiftShip recorded.
 */
const settlementStatusFor = (parcel, remittance) => {
  if (!parcel.cod?.collectedAt) return 'not_collected'
  return remittance ? remittance.status : 'awaiting_remittance'
}

/**
 * Ledger tab filters, keyed the same way the export endpoint receives
 * `?status=`. Exported for the unit tests so the tab chips and the CSV can
 * never drift apart.
 */
export const LEDGER_STATUS_FILTERS = {
  to_collect: (row) => row.settlementStatus === 'not_collected',
  awaiting_remittance: (row) => row.settlementStatus === 'awaiting_remittance',
  in_remittance: (row) => row.settlementStatus === 'pending' || row.settlementStatus === 'processing',
  remitted: (row) => row.settlementStatus === 'paid',
}

/** Narrows ledger rows to one tab filter; an unknown filter means "all". */
export const filterLedgerRows = (rows, status) =>
  LEDGER_STATUS_FILTERS[status] ? rows.filter(LEDGER_STATUS_FILTERS[status]) : rows

/**
 * Builds the merchant's COD ledger from already-serialized parcels plus the
 * remittance batches their cash sits in.
 *
 * Pure on purpose: the settlement state machine and the summary totals are
 * the interesting logic, so this is what the unit tests exercise. Only COD
 * parcels (`cod.required`) ever appear; prepaid bookings live on their
 * Payment rows and are shown separately.
 *
 * @param {Array<object>} parcels serialized merchant parcels
 * @param {Array<object>} remittances lean MerchantRemittance documents
 */
export const buildCodLedger = (parcels, remittances = []) => {
  const remittanceByParcel = new Map()
  for (const remittance of remittances) {
    for (const parcelId of remittance.parcelIds || []) {
      remittanceByParcel.set(String(parcelId), remittance)
    }
  }

  const rows = parcels
    .filter((parcel) => parcel.cod?.required)
    .map((parcel) => {
      const remittance = remittanceByParcel.get(String(parcel._id)) || null

      return {
        _id: parcel._id,
        trackingId: parcel.trackingId,
        status: parcel.status,
        deliveredAt: parcel.status === 'delivered' ? parcel.lastStatusAt || null : null,
        amount: parcel.cod.amount || 0,
        collectedAt: parcel.cod.collectedAt || null,
        /**
         * Rider -> admin deposit state. Surfaced read-only so the merchant can
         * tell "the customer paid" apart from "SwiftShip holds it", without
         * ever reading it as money owed to them.
         */
        depositStatus: parcel.cod.depositStatus,
        settlementStatus: settlementStatusFor(parcel, remittance),
        remittance: remittance
          ? {
              id: String(remittance._id),
              status: remittance.status,
              reference: remittance.reference || '',
              paidAt: remittance.paidAt || null,
              periodStart: remittance.periodStart,
              periodEnd: remittance.periodEnd,
            }
          : null,
      }
    })

  const collected = rows.filter((row) => row.collectedAt)
  const summary = {
    parcelCount: rows.length,
    toCollectAmount: rows.reduce((total, row) => total + (row.collectedAt ? 0 : row.amount), 0),
    collectedAmount: collected.reduce((total, row) => total + row.amount, 0),
    awaitingRemittanceAmount: collected.reduce(
      (total, row) => total + (row.remittance ? 0 : row.amount),
      0
    ),
    remittedNetAmount: remittances
      .filter((remittance) => remittance.status === 'paid')
      .reduce((total, remittance) => total + (remittance.netPayable || 0), 0),
  }

  return { rows, summary }
}

/** Reads everything the ledger needs for one merchant, then builds it. */
export const getMerchantCodLedger = async (uid) => {
  const [parcels, remittances] = await Promise.all([
    listMerchantParcels(uid),
    MerchantRemittance.find({ merchantUid: uid }).lean(),
  ])

  return buildCodLedger(parcels, remittances)
}

/** Merchant-safe view of one remittance batch. */
export const serializeRemittance = (remittance) => ({
  _id: String(remittance._id),
  periodStart: remittance.periodStart,
  periodEnd: remittance.periodEnd,
  parcelCount: remittance.parcelIds?.length || 0,
  grossCollected: remittance.grossCollected || 0,
  fees: remittance.fees || 0,
  netPayable: remittance.netPayable || 0,
  status: remittance.status,
  reference: remittance.reference || '',
  paidAt: remittance.paidAt || null,
  notes: remittance.notes || '',
  createdAt: remittance.createdAt,
})

/** All of one merchant's remittance batches, newest first. */
export const listMerchantRemittances = async (uid) => {
  const remittances = await MerchantRemittance.find({ merchantUid: uid })
    .sort({ createdAt: -1 })
    .lean()

  return remittances.map(serializeRemittance)
}

/**
 * One remittance plus the parcels it settles, for the printable statement.
 * Returns `null` for a malformed id, an unknown batch, or another merchant's
 * batch - indistinguishable on purpose.
 */
export const findMerchantRemittanceById = async (uid, id) => {
  if (!mongoose.isValidObjectId(id)) return null

  const remittance = await MerchantRemittance.findOne({ _id: id, merchantUid: uid }).lean()
  if (!remittance) return null

  const parcels = await Parcel.find({ _id: { $in: remittance.parcelIds }, 'createdBy.uid': uid })
    .select('trackingId receiverName cod.amount cod.collectedAt')
    .sort({ 'cod.collectedAt': 1, createdAt: 1 })
    .lean()

  return {
    remittance: serializeRemittance(remittance),
    parcels: parcels.map((parcel) => ({
      trackingId: parcel.trackingId,
      receiverName: parcel.receiverName || '',
      amount: parcel.cod?.amount || 0,
      collectedAt: parcel.cod?.collectedAt || null,
    })),
  }
}

/** Columns for the COD ledger tab export. */
const LEDGER_EXPORT_COLUMNS = [
  { key: 'trackingId', label: 'Tracking ID' },
  { key: 'status', label: 'Parcel status' },
  { key: 'deliveredAt', label: 'Delivered at' },
  { key: 'amount', label: 'COD amount (BDT)' },
  { key: 'collectedAt', label: 'Collected at' },
  { key: 'depositStatus', label: 'Rider deposit' },
  { key: 'settlementStatus', label: 'Settlement status' },
  { key: 'remittanceReference', label: 'Remittance reference' },
  { key: 'remittancePaidAt', label: 'Remittance paid at' },
]

/** Columns for the remittances tab export. */
const REMITTANCE_EXPORT_COLUMNS = [
  { key: 'periodStart', label: 'Period start' },
  { key: 'periodEnd', label: 'Period end' },
  { key: 'parcelCount', label: 'Parcels' },
  { key: 'grossCollected', label: 'Gross collected (BDT)' },
  { key: 'fees', label: 'Fees (BDT)' },
  { key: 'netPayable', label: 'Net payable (BDT)' },
  { key: 'status', label: 'Status' },
  { key: 'reference', label: 'Reference' },
  { key: 'paidAt', label: 'Paid at' },
  { key: 'createdAt', label: 'Created at' },
]

/**
 * Builds one of the payments-page exports, mirroring the active tab: the COD
 * ledger (optionally narrowed to the active settlement filter) or the
 * remittance batches.
 *
 * @param {string} uid Firebase uid of the merchant
 * @param {{resource?: 'cod-ledger'|'remittances', status?: string}} [filters]
 */
export const buildMerchantPaymentsExport = async (
  uid,
  { resource = 'cod-ledger', status = '' } = {}
) => {
  if (resource === 'remittances') {
    const remittances = await listMerchantRemittances(uid)
    return {
      columns: REMITTANCE_EXPORT_COLUMNS,
      rows: remittances.slice(0, MAX_MERCHANT_EXPORT_ROWS),
      total: remittances.length,
    }
  }

  const { rows } = await getMerchantCodLedger(uid)
  const filtered = filterLedgerRows(rows, status)

  return {
    columns: LEDGER_EXPORT_COLUMNS,
    rows: filtered.slice(0, MAX_MERCHANT_EXPORT_ROWS).map((row) => ({
      trackingId: row.trackingId,
      status: row.status,
      deliveredAt: row.deliveredAt || '',
      amount: row.amount,
      collectedAt: row.collectedAt || '',
      depositStatus: row.depositStatus,
      settlementStatus: row.settlementStatus,
      remittanceReference: row.remittance?.reference || '',
      remittancePaidAt: row.remittance?.paidAt || '',
    })),
    total: filtered.length,
  }
}
