import asyncHandler from '../middleware/asyncHandler.js'
import MerchantApplication from '../models/merchantApplication.model.js'
import Parcel from '../models/parcel.model.js'
import Payment from '../models/payment.model.js'
import PickupRequest from '../models/pickupRequest.model.js'
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
import { calculateDeliveryCharge } from '../services/delivery-pricing.service.js'
import {
  buildBulkPreview,
  buildBulkTemplateColumns,
  commitBulkUpload,
  MAX_BULK_CSV_LENGTH,
} from '../services/merchant-bulk.service.js'
import { buildReturnParcel, returnEligibility } from '../services/merchant-return.service.js'
import {
  MAX_PICKUP_ADDRESSES,
  resolvePickupAddress,
  serializePickup,
  serializePickupAddress,
  validatePickupAddress,
  validatePickupRequest,
} from '../services/pickup.service.js'
import { csvBody, csvFilename } from '../utils/csv.js'
import { BD_PHONE } from '../utils/phone.js'
import { generateTrackingId } from '../utils/tracking.js'

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
  pickupAddresses: (merchant.pickupAddresses || []).map(serializePickupAddress),
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

/** ObjectId shape check: a malformed :id is a 404, never a CastError 500. */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i

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
 * POST /api/merchant/parcels/:id/return
 *
 * Books a reverse pickup: the original receiver hands the goods back and the
 * rider brings them to the merchant's pickup address. Only a delivered
 * forward parcel can be returned, and only one return may be in flight at a
 * time - a cancelled attempt frees the original to be returned again.
 *
 * The pickup address text defaults to the original receiver's but the merchant
 * may correct it; the drop-off side resolves server-side (chosen address-book
 * entry via `addressId`, else the default entry, else the profile address).
 * Pricing runs through the shared quote service, and the charge is recorded on
 * a pending `online` payment - a return is never COD cash.
 */
export const createMerchantReturn = asyncHandler(async (req, res) => {
  if (!OBJECT_ID_PATTERN.test(String(req.params.id))) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  const original = await Parcel.findOne({
    _id: req.params.id,
    'createdBy.uid': req.user.uid,
  }).lean()
  if (!original) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  const [status, activeReturn] = await Promise.all([
    latestParcelStatus(original._id),
    Parcel.exists({
      'returnOf.parcelId': original._id,
      'cancellation.cancelledAt': null,
    }),
  ])

  const eligibility = returnEligibility({
    status,
    direction: original.direction,
    hasActiveReturn: Boolean(activeReturn),
  })
  if (!eligibility.ok) {
    return res.status(409).json({ error: eligibility.error })
  }

  const { error: addressError, source: dropAddress } = resolvePickupAddress(
    req.merchant,
    req.body?.addressId || ''
  )
  if (addressError) {
    return res.status(400).json({ error: addressError })
  }

  const pricing = await calculateDeliveryCharge({
    type: original.type,
    weight: original.weight,
    senderServiceCenter: original.receiverServiceCenter,
    receiverServiceCenter: dropAddress.district,
  })

  const { errors, parcel: fields } = buildReturnParcel({
    original,
    merchant: req.merchant,
    dropAddress,
    payload: req.body,
    pricing,
  })
  if (errors.length) {
    return res.status(400).json({ error: errors.join(' ') })
  }

  const parcel = await Parcel.create({ trackingId: generateTrackingId(), ...fields })

  try {
    await Promise.all([
      Payment.create({
        parcel: parcel._id,
        trackingId: parcel.trackingId,
        method: 'online',
        status: 'pending',
        amount: parcel.deliveryCost,
      }),
      Tracking.create({
        parcel: parcel._id,
        trackingId: parcel.trackingId,
        status: 'pending',
        message: `Return booking created (return of ${original.trackingId})`,
        updatedBy: { uid: req.user.uid, name: merchantDisplayName(req) },
      }),
    ])
  } catch (createError) {
    await Promise.allSettled([
      Payment.deleteMany({ parcel: parcel._id }),
      Tracking.deleteMany({ parcel: parcel._id }),
      parcel.deleteOne(),
    ])
    throw createError
  }

  const created = await findMerchantParcelById(req.user.uid, parcel._id)
  return res.status(201).json(created)
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

// ---- Bulk CSV upload ----

/**
 * GET /api/merchant/parcels/bulk/template
 *
 * Header-only CSV generated from the same column list the importer matches
 * against, so the template a merchant downloads is always accepted.
 */
export const getBulkTemplate = asyncHandler(async (req, res) => {
  const filename = csvFilename('bulk-shipment-template')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(csvBody(buildBulkTemplateColumns(), []))
})

/**
 * Shared body guard for both bulk endpoints. Responds and returns `null` when
 * the payload is unusable, so callers only proceed with a real CSV string.
 */
const readBulkCsv = (req, res) => {
  const csv = typeof req.body?.csv === 'string' ? req.body.csv : ''

  if (!csv.trim()) {
    res.status(400).json({ error: 'Upload a CSV file to continue.' })
    return null
  }
  if (csv.length > MAX_BULK_CSV_LENGTH) {
    res.status(400).json({
      error: 'The file is too large. Keep uploads under 500 KB (about 500 rows).',
    })
    return null
  }

  return csv
}

/**
 * POST /api/merchant/parcels/bulk
 *
 * Read-only validation preview: every row gets a pass/fail verdict, a reason
 * when it fails, and server-side pricing when it passes. Nothing is written.
 */
export const previewBulkParcels = asyncHandler(async (req, res) => {
  const csv = readBulkCsv(req, res)
  if (!csv) return undefined

  const preview = await buildBulkPreview(csv, req.merchant)
  if (preview.headerErrors.length) {
    return res.status(400).json({ error: preview.headerErrors.join(' ') })
  }

  return res.json(preview)
})

/**
 * POST /api/merchant/parcels/bulk/commit
 *
 * Creates the rows that passed validation and reports the rest. The CSV is
 * re-validated and re-priced here: the preview is a convenience, never an
 * authority.
 */
export const createBulkParcels = asyncHandler(async (req, res) => {
  const csv = readBulkCsv(req, res)
  if (!csv) return undefined

  const result = await commitBulkUpload(csv, req.merchant, req.user)
  if (result.headerErrors.length) {
    return res.status(400).json({ error: result.headerErrors.join(' ') })
  }

  return res.status(201).json(result)
})

// ---- Pickups & the pickup address book ----

/** The serialized address book, as returned by every address mutation. */
const serializeAddressBook = (merchant) =>
  (merchant.pickupAddresses || []).map(serializePickupAddress)

/** Subdocument lookup, guarded against malformed ids. */
const findPickupAddress = (merchant, addressId) => {
  if (!OBJECT_ID_PATTERN.test(String(addressId))) return null

  return merchant.pickupAddresses.id(addressId) || null
}

/**
 * GET /api/merchant/pickups
 *
 * The merchant's own pickups, newest pickup day first. `scheduled` and
 * `completed` are admin-side transitions that arrive with dispatch tooling;
 * merchants create (`requested`) and cancel (`cancelled`).
 */
export const getMerchantPickups = asyncHandler(async (req, res) => {
  const pickups = await PickupRequest.find({ merchantUid: req.user.uid })
    .sort({ date: -1, createdAt: -1 })
    .lean()

  return res.json({ pickups: pickups.map(serializePickup) })
})

/**
 * POST /api/merchant/pickups
 *
 * Books a pickup. The address is resolved server-side, never trusted from the
 * client: the chosen address-book entry, else the default entry, else the
 * address recorded on the approved application.
 */
export const createMerchantPickup = asyncHandler(async (req, res) => {
  const { addressId = '', date, timeWindow, parcelCount, notes } = req.body || {}
  const merchant = req.merchant

  // The address resolves server-side, never trusted from the client: the
  // chosen address-book entry, else the default entry, else the address
  // recorded on the approved application (profile phone as contact fallback).
  const { error, source: resolved } = resolvePickupAddress(merchant, addressId)
  if (error) {
    return res.status(400).json({ error })
  }

  const { errors, value } = validatePickupRequest({
    ...resolved,
    date,
    timeWindow,
    parcelCount,
    notes,
  })
  if (errors.length) {
    return res.status(400).json({ error: errors.join(' ') })
  }

  const pickup = await PickupRequest.create({
    merchantUid: req.user.uid,
    businessName: merchant.businessName,
    addressLabel: resolved.label,
    region: value.region,
    district: value.district,
    address: value.address,
    contactPhone: value.contactPhone,
    date: value.date,
    timeWindow: value.timeWindow,
    parcelCount: value.parcelCount,
    notes: value.notes,
  })

  return res.status(201).json(serializePickup(pickup))
})

/**
 * PATCH /api/merchant/pickups/:id/cancel
 *
 * Only while the pickup is still `requested` - once dispatch has scheduled a
 * rider, cancelling is a support operation. The reason is optional but kept
 * for whoever reviews the day's route sheet.
 */
export const cancelMerchantPickup = asyncHandler(async (req, res) => {
  if (!OBJECT_ID_PATTERN.test(String(req.params.id))) {
    return res.status(404).json({ error: 'Pickup not found' })
  }

  const pickup = await PickupRequest.findOne({
    _id: req.params.id,
    merchantUid: req.user.uid,
  })
  if (!pickup) {
    return res.status(404).json({ error: 'Pickup not found' })
  }
  if (pickup.status !== 'requested') {
    return res.status(409).json({
      error: 'Only a pickup that is still requested can be cancelled. Contact support instead.',
    })
  }

  pickup.status = 'cancelled'
  pickup.cancelledAt = new Date()
  pickup.cancelReason = String(req.body?.reason || '').trim()
  await pickup.save()

  return res.json(serializePickup(pickup))
})

/**
 * POST /api/merchant/pickup-addresses
 *
 * Adds one entry to the address book. The first entry (or an explicit
 * `isDefault: true`) becomes the default; the profile-level `pickupAddress`
 * stays as the fallback for merchants who never build an address book.
 */
export const createPickupAddress = asyncHandler(async (req, res) => {
  const merchant = req.merchant
  if (!merchant.pickupAddresses) merchant.pickupAddresses = []

  const addresses = merchant.pickupAddresses
  if (addresses.length >= MAX_PICKUP_ADDRESSES) {
    return res.status(400).json({
      error: `Your address book is full (max ${MAX_PICKUP_ADDRESSES} addresses). Remove one first.`,
    })
  }

  const { errors, value } = validatePickupAddress(req.body || {})
  if (errors.length) {
    return res.status(400).json({ error: errors.join(' ') })
  }

  const makeDefault = req.body?.isDefault === true || addresses.length === 0
  if (makeDefault) {
    for (const entry of addresses) entry.isDefault = false
  }

  addresses.push({ ...value, isDefault: makeDefault })
  await merchant.save()

  return res.status(201).json({ addresses: serializeAddressBook(merchant) })
})

/**
 * PATCH /api/merchant/pickup-addresses/:id
 *
 * Partial update; `isDefault: true` moves the default badge to this entry
 * (un-defaulting happens by defaulting another one, so the book always has a
 * default when it has entries).
 */
export const updatePickupAddress = asyncHandler(async (req, res) => {
  const merchant = req.merchant
  const entry = findPickupAddress(merchant, req.params.id)
  if (!entry) {
    return res.status(404).json({ error: 'Address not found' })
  }

  const body = req.body || {}
  const at = (key, current) => (body[key] !== undefined ? body[key] : current)

  const { errors, value } = validatePickupAddress({
    label: at('label', entry.label),
    region: at('region', entry.region),
    district: at('district', entry.district),
    address: at('address', entry.address),
    contact: at('contact', entry.contact),
  })
  if (errors.length) {
    return res.status(400).json({ error: errors.join(' ') })
  }

  entry.label = value.label
  entry.region = value.region
  entry.district = value.district
  entry.address = value.address
  entry.contact = value.contact

  if (body.isDefault === true) {
    const targetId = String(entry._id)
    for (const other of merchant.pickupAddresses) {
      other.isDefault = String(other._id) === targetId
    }
  }

  await merchant.save()
  return res.json({ addresses: serializeAddressBook(merchant) })
})

/**
 * DELETE /api/merchant/pickup-addresses/:id
 *
 * Removing the default promotes the oldest remaining entry, so the next
 * pickup request never silently falls back to the stale profile address.
 */
export const deletePickupAddress = asyncHandler(async (req, res) => {
  const merchant = req.merchant
  const entry = findPickupAddress(merchant, req.params.id)
  if (!entry) {
    return res.status(404).json({ error: 'Address not found' })
  }

  const wasDefault = Boolean(entry.isDefault)
  const remaining = merchant.pickupAddresses.filter(
    (other) => String(other._id) !== String(entry._id)
  )

  entry.deleteOne()

  if (wasDefault && remaining.length) {
    remaining[0].isDefault = true
  }

  await merchant.save()
  return res.json({ addresses: serializeAddressBook(merchant) })
})
