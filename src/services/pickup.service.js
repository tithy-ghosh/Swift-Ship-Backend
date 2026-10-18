import { findDistrict } from '../utils/districts.js'
import { normalizeBdPhone } from '../utils/phone.js'

/**
 * Pickup scheduling and the merchant address book.
 *
 * Validation lives here, pure and database-free. Pickup dates are compared as
 * Dhaka calendar days - the server's timezone must never decide whether
 * "today" is a bookable day - and coverage reuses the same static district
 * table the bulk importer validates against.
 */

/** The windows the request form offers; membership is checked server-side. */
export const PICKUP_TIME_WINDOWS = ['09:00-12:00', '12:00-15:00', '15:00-18:00']

/** How far ahead a pickup can be requested. */
export const MAX_PICKUP_DAYS_AHEAD = 30

/** Address-book cap; keeps the subdocument list and the UI sane. */
export const MAX_PICKUP_ADDRESSES = 10

const MAX_PARCELS_PER_REQUEST = 100
const MAX_ADDRESS_LENGTH = 200
const MAX_LABEL_LENGTH = 60
const MAX_NOTES_LENGTH = 300

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Today as `YYYY-MM-DD` in Dhaka, whatever the server's timezone is. */
export const dhakaDateString = (date = new Date()) =>
  date.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

/** True for `YYYY-MM-DD` strings that are real calendar days (no Feb 31). */
const isRealCalendarDay = (dateString) => {
  const [year, month, day] = dateString.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

/**
 * Calendar-day distance between two `YYYY-MM-DD` strings.
 *
 * Anchored to UTC midnight so offsets and DST can never skew the count.
 */
const daysBetween = (from, to) => {
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number)
  const [toYear, toMonth, toDay] = to.split('-').map(Number)

  return (
    (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) /
    86_400_000
  )
}

/**
 * Region + district pair validation shared by requests and address entries.
 *
 * The district must be covered, and a provided region that contradicts it is
 * an error rather than silently "fixed"; a blank region is filled from the
 * table. Writes the canonical pair onto `target`.
 */
const validateCoverage = (rawRegion, rawDistrict, target, errors) => {
  const districtInput = String(rawDistrict || '').trim()
  const district = districtInput ? findDistrict(districtInput) : null

  if (!district) {
    errors.push(
      districtInput
        ? `Unknown pickup district "${districtInput}". Use a covered district name.`
        : 'Pickup district is required.'
    )
    return
  }

  const region = String(rawRegion || '').trim()
  if (region && region.toLowerCase() !== district.region.toLowerCase()) {
    errors.push(
      `Pickup region "${region}" does not match district "${district.district}" (which is in ${district.region}).`
    )
  }

  target.region = district.region
  target.district = district.district
}

/**
 * Validates and normalises one pickup request.
 *
 * @param {{region?: string, district?: string, address?: string, contactPhone?: string,
 *          date?: string, timeWindow?: string, parcelCount?: number|string,
 *          notes?: string}} [payload]
 * @param {{today?: string}} [options] `today` is injectable for tests
 * @returns {{errors: string[], value: {
 *   region: string, district: string, address: string, contactPhone: string,
 *   date: Date|null, timeWindow: string, parcelCount: number, notes: string}}}
 *   `value` is only meaningful when `errors` is empty.
 */
export const validatePickupRequest = (payload = {}, { today = dhakaDateString() } = {}) => {
  const errors = []
  const value = {
    region: '',
    district: '',
    address: String(payload.address || '').trim(),
    contactPhone: '',
    date: null,
    timeWindow: '',
    parcelCount: 0,
    notes: String(payload.notes || '').trim(),
  }

  validateCoverage(payload.region, payload.district, value, errors)

  if (!value.address) {
    errors.push('Pickup address is required.')
  } else if (value.address.length > MAX_ADDRESS_LENGTH) {
    errors.push(`Pickup address is too long (max ${MAX_ADDRESS_LENGTH} characters).`)
  }

  const contactInput = String(payload.contactPhone || '').trim()
  if (!contactInput) {
    errors.push('A contact phone for the pickup is required.')
  } else {
    const phone = normalizeBdPhone(contactInput)
    if (!phone) {
      errors.push(
        `Pickup contact "${contactInput}" is not a valid Bangladeshi mobile number (01XXXXXXXXX).`
      )
    } else {
      value.contactPhone = phone
    }
  }

  const dateInput = String(payload.date || '').trim()
  if (!DATE_PATTERN.test(dateInput) || !isRealCalendarDay(dateInput)) {
    errors.push('Pickup date must be a real calendar day in YYYY-MM-DD form.')
  } else {
    const daysAhead = daysBetween(today, dateInput)
    if (daysAhead < 0) {
      errors.push('Pickup date cannot be in the past.')
    } else if (daysAhead > MAX_PICKUP_DAYS_AHEAD) {
      errors.push(`Pickup date must be within the next ${MAX_PICKUP_DAYS_AHEAD} days.`)
    } else {
      // Midnight in Dhaka, so the stored day cannot drift across timezones.
      value.date = new Date(`${dateInput}T00:00:00+06:00`)
    }
  }

  const timeWindow = String(payload.timeWindow || '').trim()
  if (!PICKUP_TIME_WINDOWS.includes(timeWindow)) {
    errors.push(`Time window must be one of: ${PICKUP_TIME_WINDOWS.join(', ')}.`)
  } else {
    value.timeWindow = timeWindow
  }

  const parcelCount = Number(payload.parcelCount)
  if (
    !Number.isInteger(parcelCount) ||
    parcelCount < 1 ||
    parcelCount > MAX_PARCELS_PER_REQUEST
  ) {
    errors.push(
      `Expected parcel count must be a whole number between 1 and ${MAX_PARCELS_PER_REQUEST}.`
    )
  } else {
    value.parcelCount = parcelCount
  }

  if (value.notes.length > MAX_NOTES_LENGTH) {
    errors.push(`Notes are too long (max ${MAX_NOTES_LENGTH} characters).`)
  }

  return { errors, value }
}

/**
 * Validates and normalises one address-book entry.
 *
 * The contact phone is optional (`''` passes): a request made from an entry
 * without one falls back to the merchant's profile phone at request time.
 *
 * @param {{label?: string, region?: string, district?: string, address?: string, contact?: string}} [payload]
 * @returns {{errors: string[], value: {
 *   label: string, region: string, district: string, address: string, contact: string}}}
 */
export const validatePickupAddress = (payload = {}) => {
  const errors = []
  const value = {
    label: String(payload.label || '').trim(),
    region: '',
    district: '',
    address: String(payload.address || '').trim(),
    contact: '',
  }

  if (value.label.length > MAX_LABEL_LENGTH) {
    errors.push(`Address label is too long (max ${MAX_LABEL_LENGTH} characters).`)
  }

  validateCoverage(payload.region, payload.district, value, errors)

  if (!value.address) {
    errors.push('Pickup address is required.')
  } else if (value.address.length > MAX_ADDRESS_LENGTH) {
    errors.push(`Pickup address is too long (max ${MAX_ADDRESS_LENGTH} characters).`)
  }

  const contactInput = String(payload.contact || '').trim()
  if (contactInput) {
    const phone = normalizeBdPhone(contactInput)
    if (!phone) {
      errors.push(
        `Contact "${contactInput}" is not a valid Bangladeshi mobile number (01XXXXXXXXX).`
      )
    } else {
      value.contact = phone
    }
  }

  return { errors, value }
}

/**
 * Resolves which stop a pickup request or a return shipment collects from.
 *
 * The client may name an address-book entry; otherwise the default entry (or
 * the oldest one) is used, and merchants who never built a book fall back to
 * the address on the approved application. Shared by pickup scheduling and
 * returns so both resolve the merchant's side identically.
 *
 * @param {object} merchant approved MerchantApplication (document or lean)
 * @param {string} [addressId] chosen address-book entry id
 * @returns {{error: string, source: {
 *   label: string, region: string, district: string, address: string, contactPhone: string}|null}}
 */
export const resolvePickupAddress = (merchant, addressId = '') => {
  const addresses = merchant.pickupAddresses || []

  // Address-book contact is optional; the profile phone is the last resort.
  const toSource = (entry) => ({
    label: entry.label || '',
    region: entry.region,
    district: entry.district,
    address: entry.address,
    contactPhone: entry.contact || merchant.phone || '',
  })

  if (addressId) {
    const chosen = addresses.find((entry) => String(entry._id) === String(addressId)) || null
    if (!chosen) {
      return { error: 'That pickup address is not in your address book anymore.', source: null }
    }

    return { error: '', source: toSource(chosen) }
  }

  const fallback = addresses.find((entry) => entry.isDefault) || addresses[0] || null
  if (fallback) return { error: '', source: toSource(fallback) }

  return {
    error: '',
    source: {
      label: '',
      region: merchant.region,
      district: merchant.district,
      address: merchant.pickupAddress,
      contactPhone: merchant.phone || '',
    },
  }
}

/** Merchant-safe view of a pickup request. */
export const serializePickup = (pickup) => ({
  _id: String(pickup._id),
  businessName: pickup.businessName || '',
  addressLabel: pickup.addressLabel || '',
  region: pickup.region,
  district: pickup.district,
  address: pickup.address,
  contactPhone: pickup.contactPhone,
  date: pickup.date,
  timeWindow: pickup.timeWindow,
  parcelCount: pickup.parcelCount,
  status: pickup.status,
  canCancel: pickup.status === 'requested',
  notes: pickup.notes || '',
  cancelReason: pickup.cancelReason || '',
  cancelledAt: pickup.cancelledAt || null,
  createdAt: pickup.createdAt,
})

/** One address-book entry, with its subdocument id as a string. */
export const serializePickupAddress = (address) => ({
  _id: String(address._id),
  label: address.label || '',
  region: address.region,
  district: address.district,
  address: address.address,
  contact: address.contact || '',
  isDefault: Boolean(address.isDefault),
})
