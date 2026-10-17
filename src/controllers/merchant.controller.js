import asyncHandler from '../middleware/asyncHandler.js'
import MerchantApplication from '../models/merchantApplication.model.js'
import Parcel from '../models/parcel.model.js'
import Tracking, { TRACKING_STATUSES } from '../models/tracking.model.js'
import {
  buildMerchantParcelsExport,
  buildMerchantPaymentsExport,
  buildMerchantSummary,
  findMerchantParcelById,
  findMerchantRemittanceById,
  getMerchantCodLedger,
  listMerchantParcels,
  listMerchantRemittances,
} from '../services/merchant.service.js'
import { findActiveAnnouncementsFor } from '../services/announcement.service.js'
import { csvBody, csvFilename } from '../utils/csv.js'

/** Same pattern the application form enforces, kept in sync on the server. */
const BD_PHONE = /^01[3-9]\d{8}$/

const TRACKING_STATUS_SET = new Set(TRACKING_STATUSES)

/**
 * Fields a merchant may change without an admin re-review.
 *
 * Identity and coverage fields (`businessName`, `businessType`, `region`,
 * `district`, `monthlyOrders`) are deliberately excluded: they are what the
 * admin approved, and letting a merchant rewrite them would quietly invalidate
 * that review. Changing those goes through support until a review flow exists.
 */
const EDITABLE_PROFILE_FIELDS = new Set([
  'phone',
  'pickupAddress',
  'website',
  'needsCOD',
  'notes',
])

/**
 * The merchant-safe view of their own application.
 *
 * `adminNotes` is surfaced on purpose: it carries the approval note, and the
 * rejection/deactivation reason when one exists, and the merchant is the one
 * person who should be able to read it.
 */
const serializeMerchantProfile = (merchant) => ({
  _id: String(merchant._id),
  businessName: merchant.businessName,
  businessType: merchant.businessType,
  name: merchant.name,
  email: merchant.email,
  phone: merchant.phone,
  region: merchant.region,
  district: merchant.district,
  pickupAddress: merchant.pickupAddress,
  monthlyOrders: merchant.monthlyOrders || '',
  website: merchant.website || '',
  needsCOD: Boolean(merchant.needsCOD),
  notes: merchant.notes || '',
  adminNotes: merchant.adminNotes || '',
  status: merchant.status,
  createdAt: merchant.createdAt,
  updatedAt: merchant.updatedAt,
})

/** The display name used on tracking events written by the merchant. */
const merchantDisplayName = (req) =>
  req.merchant?.businessName || req.merchant?.name || req.user.name || req.user.email || 'Merchant'

/**
 * Latest tracking status for a parcel, or `pending` when the log is empty.
 * Mirrors the newest-event read used by the list joins.
 */
const latestParcelStatus = async (parcelId) => {
  const latest = await Tracking.findOne({ parcel: parcelId })
    .sort({ eventTime: -1, createdAt: -1 })
    .select('status')
    .lean()

  return latest?.status || 'pending'
}

/** GET /api/merchant/summary */
export const getMerchantSummary = asyncHandler(async (req, res) => {
  const parcels = await listMerchantParcels(req.user.uid)
  return res.json(buildMerchantSummary(parcels))
})

/** GET /api/merchant/profile */
export const getMerchantProfile = asyncHandler(async (req, res) => {
  return res.json(serializeMerchantProfile(req.merchant))
})

/**
 * GET /api/merchant/announcements/active
 *
 * Announcements addressed to merchants (or everyone), newest first.
 *
 * The audience filter is server-side: a merchant must never receive a
 * riders-only or customers-only message even if the client asks for one.
 * Non-critical callers (the workspace home banner) can ignore a failure and
 * render without announcements.
 */
export const getMerchantAnnouncements = asyncHandler(async (req, res) => {
  const announcements = await findActiveAnnouncementsFor('merchant')
  return res.json({ announcements })
})

/**
 * PATCH /api/merchant/profile
 *
 * Updates only the whitelisted fields; anything else in the body is ignored
 * rather than rejected so a future client sending a whole profile object back
 * does not break. At least one editable field must be present or the request
 * is a mistake worth reporting.
 */
export const updateMerchantProfile = asyncHandler(async (req, res) => {
  const updates = {}

  for (const [key, value] of Object.entries(req.body || {})) {
    if (!EDITABLE_PROFILE_FIELDS.has(key)) continue

    if (key === 'needsCOD') {
      updates.needsCOD = typeof value === 'boolean' ? value : String(value) === 'true'
      continue
    }

    updates[key] = typeof value === 'string' ? value.trim() : value
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({
      error: `Provide at least one editable field: ${[...EDITABLE_PROFILE_FIELDS].join(', ')}`,
    })
  }

  if (updates.phone !== undefined && !BD_PHONE.test(updates.phone)) {
    return res.status(400).json({ error: 'Invalid BD phone number' })
  }
  if (updates.pickupAddress !== undefined && !updates.pickupAddress) {
    return res.status(400).json({ error: 'Pickup address cannot be empty' })
  }

  const merchant = await MerchantApplication.findByIdAndUpdate(
    req.merchant._id,
    { $set: updates },
    { new: true, runValidators: true }
  )

  return res.json(serializeMerchantProfile(merchant))
})

/**
 * GET /api/merchant/parcels?status=&q=
 *
 * The merchant's own parcels. `status` (a tracking status) and `q` (tracking
 * id / receiver name / receiver phone) narrow the list; both are optional.
 */
export const getMerchantParcels = asyncHandler(async (req, res) => {
  const { status = '', q = '' } = req.query

  let parcels = await listMerchantParcels(req.user.uid, { search: q })
  if (TRACKING_STATUS_SET.has(status)) {
    parcels = parcels.filter((parcel) => parcel.status === status)
  }

  return res.json(parcels)
})

/** GET /api/merchant/parcels/:id */
export const getMerchantParcel = asyncHandler(async (req, res) => {
  const parcel = await findMerchantParcelById(req.user.uid, req.params.id)
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  return res.json(parcel)
})

/**
 * PATCH /api/merchant/parcels/:id/receiver
 *
 * Corrects the receiver's details while the parcel is still `pending` and no
 * rider has claimed it. Coverage (region/service center) is not editable: it
 * feeds the pricing and routing decisions made at booking time.
 */
export const updateMerchantParcelReceiver = asyncHandler(async (req, res) => {
  const parcel = await Parcel.findOne({ _id: req.params.id, 'createdBy.uid': req.user.uid })

  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  const status = await latestParcelStatus(parcel._id)
  if (parcel.assignedRider?.uid || status !== 'pending') {
    return res.status(409).json({
      error: 'Receiver details can only be edited before the parcel is picked up.',
    })
  }

  const updates = {}
  const { receiverName, receiverContact, receiverAddress, deliveryInstruction } = req.body || {}

  if (receiverName !== undefined) {
    const value = String(receiverName).trim()
    if (!value) return res.status(400).json({ error: 'Receiver name cannot be empty' })
    updates.receiverName = value
  }
  if (receiverContact !== undefined) {
    const value = String(receiverContact).trim()
    if (!BD_PHONE.test(value)) {
      return res.status(400).json({ error: 'Invalid BD phone number' })
    }
    updates.receiverContact = value
  }
  if (receiverAddress !== undefined) {
    updates.receiverAddress = String(receiverAddress).trim()
  }
  if (deliveryInstruction !== undefined) {
    updates.deliveryInstruction = String(deliveryInstruction).trim()
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No receiver fields provided.' })
  }

  await Parcel.updateOne({ _id: parcel._id }, { $set: updates })

  const updated = await findMerchantParcelById(req.user.uid, req.params.id)
  return res.json(updated)
})

/**
 * PATCH /api/merchant/parcels/:id/cancel
 *
 * A merchant may stop their own parcel only while it is `pending` and
 * unassigned - once a rider is holding it, releasing them is an admin/support
 * operation. The reason is stored on the parcel (the same field the admin and
 * rider paths write) so cancellation reporting keeps one source.
 */
export const cancelMerchantParcel = asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || '').trim()
  if (!reason) {
    return res.status(400).json({ error: 'A cancellation reason is required' })
  }

  const parcel = await Parcel.findOne({ _id: req.params.id, 'createdBy.uid': req.user.uid })
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  const status = await latestParcelStatus(parcel._id)
  if (parcel.assignedRider?.uid || status !== 'pending') {
    return res.status(409).json({
      error: 'This parcel can no longer be cancelled. Contact support for help.',
    })
  }

  const cancelledAt = new Date()

  await Parcel.updateOne(
    { _id: parcel._id },
    {
      $set: {
        cancellation: {
          reason,
          cancelledAt,
          cancelledBy: {
            uid: req.user.uid,
            name: merchantDisplayName(req),
            role: 'merchant',
          },
        },
      },
    }
  )

  await Tracking.create({
    parcel: parcel._id,
    trackingId: parcel.trackingId,
    status: 'cancelled',
    message: `Cancelled by merchant: ${reason}`,
    eventTime: cancelledAt,
    updatedBy: { uid: req.user.uid, name: merchantDisplayName(req) },
  })

  const updated = await findMerchantParcelById(req.user.uid, req.params.id)
  return res.json(updated)
})

/**
 * GET /api/merchant/parcels/export?format=csv|json&status=
 *
 * Downloads the merchant's own parcels. Reuses the shared CSV helpers so the
 * file opens correctly in Excel with Bengali text and neutralised formulas.
 */
export const exportMerchantParcels = asyncHandler(async (req, res) => {
  const { format = 'csv', status = '' } = req.query

  const { columns, rows, total } = await buildMerchantParcelsExport(req.user.uid, { status })
  const truncated = total > rows.length

  if (format === 'json') {
    return res.json({
      resource: 'merchant-parcels',
      exportedAt: new Date(),
      total,
      truncated,
      rows,
    })
  }

  const filename = csvFilename('merchant-parcels')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(csvBody(columns, rows))
})

/**
 * GET /api/merchant/cod-ledger
 *
 * One row per COD parcel: what the customer owes, what the rider has
 * collected, and which remittance batch the cash sits in (if any). The
 * summary carries the page's money cards.
 */
export const getCodLedger = asyncHandler(async (req, res) => {
  const { rows, summary } = await getMerchantCodLedger(req.user.uid)
  return res.json({ ledger: rows, summary })
})

/** GET /api/merchant/remittances */
export const getMerchantRemittances = asyncHandler(async (req, res) => {
  const remittances = await listMerchantRemittances(req.user.uid)
  return res.json({ remittances })
})

/** GET /api/merchant/remittances/:id — batch + settled parcels (statement). */
export const getMerchantRemittance = asyncHandler(async (req, res) => {
  const detail = await findMerchantRemittanceById(req.user.uid, req.params.id)
  if (!detail) {
    return res.status(404).json({ error: 'Remittance not found' })
  }

  return res.json(detail)
})

/**
 * GET /api/merchant/payments/export?resource=cod-ledger|remittances&format=csv|json&status=
 *
 * Downloads the active payments tab. On the ledger tab `status` matches the
 * settlement filter chip so the file mirrors the screen; on the remittances
 * tab it is ignored.
 */
export const exportMerchantPayments = asyncHandler(async (req, res) => {
  const { format = 'csv', resource = 'cod-ledger', status = '' } = req.query

  const { columns, rows, total } = await buildMerchantPaymentsExport(req.user.uid, {
    resource,
    status,
  })
  const truncated = total > rows.length

  if (format === 'json') {
    return res.json({
      resource,
      exportedAt: new Date(),
      total,
      truncated,
      rows,
    })
  }

  const filename = csvFilename(
    resource === 'remittances' ? 'merchant-remittances' : 'merchant-cod-ledger'
  )
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(csvBody(columns, rows))
})
