import Parcel from '../models/parcel.model.js'
import Payment from '../models/payment.model.js'
import Tracking from '../models/tracking.model.js'
import { calculateDeliveryCharge } from './delivery-pricing.service.js'
import { findDistrict } from '../utils/districts.js'
import { generateTrackingId } from '../utils/tracking.js'
import { parseCsv } from '../utils/csv.js'
import { normalizeBdPhone } from '../utils/phone.js'

/**
 * Bulk shipment import: parse -> validate -> quote -> (optionally) create.
 *
 * Split into a read-only preview and a commit so a merchant always sees a
 * row-level verdict before anything is written. The two share every step, so
 * the numbers shown in the preview are exactly what the commit is priced with.
 *
 * Rows that fail validation are never written; a commit creates the valid rows
 * and reports the rest, because rejecting a 200-row file over one typo would
 * make the feature worse than the single form.
 */

/** Hard cap per file. Bigger batches should be split across uploads. */
export const MAX_BULK_ROWS = 500

/** The raw CSV string (characters) accepted per request. */
export const MAX_BULK_CSV_LENGTH = 512 * 1024

const MAX_WEIGHT_KG = 100
const MAX_NAME_LENGTH = 120
const MAX_ADDRESS_LENGTH = 200
const MAX_TITLE_LENGTH = 120

const PARCEL_TYPES = new Set(['document', 'non-document'])
const PAYMENT_METHODS = new Set(['cod', 'online'])

/**
 * The canonical template. The server matches uploaded headers against these
 * names (case-insensitively), so column order is free and unknown extra
 * columns are ignored. The downloadable template is generated from this same
 * list, which is what keeps the two from drifting apart.
 *
 * `Receiver District` maps to `receiverServiceCenter`: in this network the
 * service centre is the district (see `utils/districts.js`).
 */
export const BULK_COLUMNS = [
  { header: 'Receiver Name', key: 'receiverName', required: true },
  { header: 'Receiver Phone', key: 'receiverContact', required: true },
  { header: 'Receiver Region', key: 'receiverRegion', required: false },
  { header: 'Receiver District', key: 'receiverDistrict', required: true },
  { header: 'Receiver Address', key: 'receiverAddress', required: true },
  { header: 'Parcel Type', key: 'type', required: false },
  { header: 'Weight (KG)', key: 'weight', required: false },
  { header: 'Item Description', key: 'title', required: false },
  { header: 'Payment Method', key: 'paymentMethod', required: false },
]

/** Columns for the downloadable template CSV. */
export const buildBulkTemplateColumns = () =>
  BULK_COLUMNS.map((column) => ({ key: column.key, label: column.header }))

const isBlank = (value) => !String(value ?? '').trim()

/**
 * Validates and normalises one data row. Pure: district coverage is a static
 * table, so this runs (and is tested) without a database.
 *
 * @param {Record<string, string|undefined>} values cells keyed by column key
 * @param {number} rowNumber 1-based spreadsheet row (header is row 1)
 * @returns {{row: number, ok: boolean, errors: string[], payload: object}}
 */
export const validateBulkRow = (values, rowNumber) => {
  const errors = []
  const payload = {
    receiverName: String(values.receiverName || '').trim(),
    receiverContact: '',
    receiverRegion: '',
    receiverServiceCenter: '',
    receiverAddress: String(values.receiverAddress || '').trim(),
    type: '',
    weight: 0,
    title: String(values.title || '').trim(),
    paymentMethod: '',
  }

  if (!payload.receiverName) {
    errors.push('Receiver name is required.')
  } else if (payload.receiverName.length > MAX_NAME_LENGTH) {
    errors.push(`Receiver name is too long (max ${MAX_NAME_LENGTH} characters).`)
  }

  if (isBlank(values.receiverContact)) {
    errors.push('Receiver phone is required.')
  } else {
    const phone = normalizeBdPhone(values.receiverContact)
    if (!phone) {
      errors.push(
        `Receiver phone "${String(values.receiverContact).trim()}" is not a valid Bangladeshi mobile number (01XXXXXXXXX).`
      )
    } else {
      payload.receiverContact = phone
    }
  }

  const district = isBlank(values.receiverDistrict)
    ? null
    : findDistrict(String(values.receiverDistrict).trim())
  if (!district) {
    errors.push(
      isBlank(values.receiverDistrict)
        ? 'Receiver district is required.'
        : `Unknown receiver district "${String(values.receiverDistrict).trim()}". Use a covered district name.`
    )
  } else {
    payload.receiverServiceCenter = district.district

    const region = String(values.receiverRegion || '').trim()
    if (region && region.toLowerCase() !== district.region.toLowerCase()) {
      errors.push(
        `Receiver region "${region}" does not match district "${district.district}" (which is in ${district.region}).`
      )
    }
    payload.receiverRegion = district.region
  }

  if (!payload.receiverAddress) {
    errors.push('Receiver address is required.')
  } else if (payload.receiverAddress.length > MAX_ADDRESS_LENGTH) {
    errors.push(`Receiver address is too long (max ${MAX_ADDRESS_LENGTH} characters).`)
  }

  // Default is non-document: pricing a 5 kg parcel as a document would quietly
  // undercharge, while the reverse only errs on the safe side and is obvious
  // in the preview.
  const type = String(values.type || '').trim().toLowerCase() || 'non-document'
  if (!PARCEL_TYPES.has(type)) {
    errors.push('Parcel type must be "document" or "non-document".')
  } else {
    payload.type = type
  }

  const rawWeight = String(values.weight ?? '').trim()
  if (rawWeight) {
    const weight = Number(rawWeight)
    if (!Number.isFinite(weight) || weight <= 0) {
      errors.push('Weight must be a positive number of kilograms.')
    } else if (weight > MAX_WEIGHT_KG) {
      errors.push(`Weight above ${MAX_WEIGHT_KG} kg needs a manual booking via support.`)
    } else if (payload.type !== 'document') {
      payload.weight = weight
    }
  } else if (payload.type !== 'document') {
    errors.push('Weight is required for non-document parcels.')
  }

  if (payload.title.length > MAX_TITLE_LENGTH) {
    errors.push(`Item description is too long (max ${MAX_TITLE_LENGTH} characters).`)
  }

  // Blank means cash on delivery - the platform default and the merchant's
  // common case. There is no merchant-specified COD amount here: in this
  // network the cash collected equals the delivery charge, priced server-side.
  const paymentMethod = String(values.paymentMethod || '').trim().toLowerCase() || 'cod'
  if (!PAYMENT_METHODS.has(paymentMethod)) {
    errors.push('Payment method must be "cod" or "online".')
  } else {
    payload.paymentMethod = paymentMethod
  }

  return { row: rowNumber, ok: errors.length === 0, errors, payload }
}

/**
 * Parses and validates a CSV document. No database access, no writes.
 *
 * @param {string} csvText
 * @returns {{headerErrors: string[], rows: Array, summary: {total: number, ready: number, invalid: number}}}
 */
export const prepareBulkUpload = (csvText) => {
  const empty = { headerErrors: [], rows: [], summary: { total: 0, ready: 0, invalid: 0 } }

  const grid = parseCsv(csvText)
  if (grid.length === 0) {
    return { ...empty, headerErrors: ['The file is empty.'] }
  }

  const header = grid[0].map((cell) => String(cell).trim().toLowerCase())
  const headerErrors = []
  const indexByKey = {}

  for (const column of BULK_COLUMNS) {
    const index = header.indexOf(column.header.toLowerCase())
    if (index >= 0) {
      indexByKey[column.key] = index
    } else if (column.required) {
      headerErrors.push(`Missing required column "${column.header}".`)
    }
  }

  if (headerErrors.length) return { ...empty, headerErrors }

  const rows = []
  for (let i = 1; i < grid.length; i += 1) {
    const cells = grid[i]
    // Spreadsheet exports love trailing blank lines; they are not row errors.
    if (cells.every((cell) => isBlank(cell))) continue

    const values = {}
    for (const [key, index] of Object.entries(indexByKey)) {
      values[key] = cells[index]
    }
    rows.push(validateBulkRow(values, i + 1))
  }

  if (rows.length > MAX_BULK_ROWS) {
    return {
      ...empty,
      headerErrors: [`Too many rows (${rows.length}). The limit is ${MAX_BULK_ROWS} per file.`],
    }
  }

  return {
    headerErrors: [],
    rows,
    summary: {
      total: rows.length,
      ready: rows.filter((row) => row.ok).length,
      invalid: rows.filter((row) => !row.ok).length,
    },
  }
}

/**
 * Adds server-side pricing to the rows that passed validation. Pricing is the
 * same `calculateDeliveryCharge` single bookings use, with the merchant's
 * district as the sender service centre.
 */
const quotePreparedRows = async (prepared, merchant) => {
  const senderServiceCenter = merchant.district

  const rows = await Promise.all(
    prepared.rows.map(async (row) => {
      if (!row.ok) return { ...row, data: row.payload }

      const pricing = await calculateDeliveryCharge({
        type: row.payload.type,
        weight: row.payload.weight,
        senderServiceCenter,
        receiverServiceCenter: row.payload.receiverServiceCenter,
      })

      return { ...row, data: { ...row.payload, ...pricing } }
    })
  )

  return {
    headerErrors: [],
    rows,
    summary: {
      ...prepared.summary,
      estimatedCost: rows.reduce(
        (total, row) => total + (row.ok ? row.data.deliveryCost || 0 : 0),
        0
      ),
    },
  }
}

/**
 * Read-only preview for the upload screen: validated rows, quoted, with an
 * estimated total. Nothing is written.
 *
 * @param {string} csvText
 * @param {object} merchant approved MerchantApplication
 */
export const buildBulkPreview = async (csvText, merchant) => {
  const prepared = prepareBulkUpload(csvText)
  if (prepared.headerErrors.length) return prepared

  return quotePreparedRows(prepared, merchant)
}

const chunk = (items, size) => {
  const chunks = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/** The identity + pickup defaults taken from the approved business profile. */
const buildSender = (merchant, user) => ({
  name: merchant.businessName || merchant.name || user.name || 'Merchant',
  contact: merchant.phone || '',
  region: merchant.region,
  serviceCenter: merchant.district,
  address: merchant.pickupAddress || '',
})

/**
 * Creates one parcel with its Payment and initial Tracking event, mirroring
 * `createParcel`: the same rollback on failure, so a half-written row can
 * never survive.
 *
 * COD rows carry `Payment.method = 'cod'`; the cash amount equals the priced
 * delivery charge and lands on `Parcel.cod` at rider-accept time, exactly like
 * a single booking.
 */
const createBulkParcel = async (row, sender, user) => {
  const { payload } = row
  const crossDistrict = sender.serviceCenter !== payload.receiverServiceCenter

  const parcel = await Parcel.create({
    trackingId: generateTrackingId(),
    type: payload.type,
    title: payload.title,
    weight: payload.weight,
    senderName: sender.name,
    senderContact: sender.contact,
    senderRegion: sender.region,
    senderServiceCenter: sender.serviceCenter,
    senderAddress: sender.address,
    receiverName: payload.receiverName,
    receiverContact: payload.receiverContact,
    receiverRegion: payload.receiverRegion,
    receiverServiceCenter: payload.receiverServiceCenter,
    receiverAddress: payload.receiverAddress,
    leg: crossDistrict ? 'pickup' : null,
    deliveryCost: payload.deliveryCost,
    deliveryZone: payload.deliveryZone,
    costBreakdown: payload.costBreakdown,
    createdBy: {
      uid: user.uid,
      email: user.email,
      name: sender.name,
    },
  })

  try {
    await Promise.all([
      Payment.create({
        parcel: parcel._id,
        trackingId: parcel.trackingId,
        method: payload.paymentMethod,
        status: 'pending',
        amount: parcel.deliveryCost,
      }),
      Tracking.create({
        parcel: parcel._id,
        trackingId: parcel.trackingId,
        status: 'pending',
        message: 'Parcel booking created',
        updatedBy: { uid: user.uid, name: sender.name },
      }),
    ])
  } catch (error) {
    await Promise.allSettled([
      Payment.deleteMany({ parcel: parcel._id }),
      Tracking.deleteMany({ parcel: parcel._id }),
      parcel.deleteOne(),
    ])
    throw error
  }

  return parcel
}

/** Chunked at ten concurrent creates: fast enough, gentle enough on Mongo. */
const CREATE_CONCURRENCY = 10

/**
 * Creates every valid row. Invalid rows are reported, never written.
 *
 * @param {string} csvText
 * @param {object} merchant approved MerchantApplication
 * @param {{uid: string, email?: string, name?: string}} user verified Firebase user
 * @returns {Promise<{headerErrors: string[], created: Array, errors: Array, summary: object}|object>}
 */
export const commitBulkUpload = async (csvText, merchant, user) => {
  const prepared = prepareBulkUpload(csvText)
  if (prepared.headerErrors.length) return prepared

  const quoted = await quotePreparedRows(prepared, merchant)
  const sender = buildSender(merchant, user)

  const created = []
  const errors = quoted.rows
    .filter((row) => !row.ok)
    .map((row) => ({
      row: row.row,
      receiverName: row.payload.receiverName,
      message: row.errors.join(' '),
    }))

  for (const batch of chunk(
    quoted.rows.filter((row) => row.ok),
    CREATE_CONCURRENCY
  )) {
    const results = await Promise.all(
      batch.map(async (row) => {
        try {
          const parcel = await createBulkParcel(row, sender, user)
          return {
            row: row.row,
            id: parcel._id,
            trackingId: parcel.trackingId,
            receiverName: row.payload.receiverName,
            receiverServiceCenter: row.payload.receiverServiceCenter,
            paymentMethod: row.payload.paymentMethod,
            deliveryCost: parcel.deliveryCost,
          }
        } catch (error) {
          return {
            row: row.row,
            receiverName: row.payload.receiverName,
            message:
              error?.code === 11000
                ? 'Tracking ID collision - please retry this row.'
                : `Could not create this shipment: ${error.message}`,
            isError: true,
          }
        }
      })
    )

    for (const result of results) {
      if (result.isError) {
        errors.push({ row: result.row, receiverName: result.receiverName, message: result.message })
      } else {
        created.push(result)
      }
    }
  }

  created.sort((a, b) => a.row - b.row)
  errors.sort((a, b) => a.row - b.row)

  return {
    headerErrors: [],
    created,
    errors,
    summary: {
      total: prepared.summary.total,
      created: created.length,
      failed: errors.length,
      totalCost: created.reduce((total, item) => total + (item.deliveryCost || 0), 0),
    },
  }
}
