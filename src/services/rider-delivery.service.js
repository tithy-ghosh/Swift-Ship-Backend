import Parcel from '../models/parcel.model.js'
import Tracking, { TRACKING_STATUSES } from '../models/tracking.model.js'
import {
  INITIAL_DELIVERY_STATUS,
  TERMINAL_DELIVERY_STATUS,
  LEG_1_COMPLETE_STATUS,
} from './delivery-flow.service.js'

/**
 * Reads delivery progress back out of the append-only Tracking collection.
 *
 * Tracking is the single source of truth for a parcel's status - the existing
 * public /track page reads it and nothing else. Denormalising the status onto
 * Parcel would be faster but would be a second source of truth, and a second
 * source of truth is how `admin.controller.js` ended up reporting
 * `pendingParcels: 0` forever by counting a `status` field that does not exist.
 *
 * The aggregation here returns the newest event per parcel in a single round
 * trip, so a rider's whole earnings history is one query, not N+1.
 */

/**
 * Newest tracking event per parcel.
 *
 * @param {import('mongoose').Types.ObjectId[]} parcelIds
 * @returns {Promise<Map<string, {status: string, eventTime: Date|null}>>}
 *   Keyed by stringified parcel id so it can be looked up without a Mongo
 *   ObjectId comparison.
 */
export const getLatestEventsByParcel = async (parcelIds) => {
  const ids = (parcelIds || []).filter(Boolean)
  if (!ids.length) return new Map()

  const rows = await Tracking.aggregate([
    { $match: { parcel: { $in: ids } } },
    // createdAt breaks ties: two events can share an eventTime when a rider
    // taps twice quickly, and without it $first is not deterministic.
    { $sort: { eventTime: -1, createdAt: -1 } },
    {
      $group: {
        _id: '$parcel',
        status: { $first: '$status' },
        eventTime: { $first: '$eventTime' },
      },
    },
  ])

  return new Map(rows.map((row) => [String(row._id), row]))
}

/**
 * Current status of a single parcel, defaulting to `pending` when it has no
 * events yet - a parcel nobody has touched is exactly what `pending` means.
 *
 * @param {import('mongoose').Types.ObjectId} parcelId
 * @returns {Promise<{status: string, eventTime: Date|null}>}
 */
export const getLatestEvent = async (parcelId) => {
  const map = await getLatestEventsByParcel([parcelId])
  return map.get(String(parcelId)) || { status: INITIAL_DELIVERY_STATUS, eventTime: null }
}

/**
 * Completed deliveries for a rider, newest first.
 *
 * "Completed" covers both kinds of ending: a `delivered` event (the rider put
 * the parcel in the customer's hands) and an `at-godown` event (a pickup-leg
 * rider parked the parcel at the sending godown - the end of THEIR work even
 * though the parcel's journey continues). Which leg a row belongs to is decided
 * by which ending it hit: `at-godown` pays out of `riderPayouts.pickup`,
 * everything else out of `riderPayouts.delivery`.
 *
 * Membership is decided by the Tracking log ("this rider delivered it"), not by
 * `assignedRider.uid`, so a parcel stays in an old rider's history after it is
 * reassigned to someone else.
 *
 * @param {string} riderUid
 * @param {Date} since Inclusive lower bound on the completing event time.
 * @returns {Promise<Array<{parcel: object, deliveredAt: Date, status: string}>>}
 */
export const listCompletedDeliveries = async (riderUid, since) => {
  const statuses = await Tracking.aggregate([
    {
      $match: {
        status: { $in: [TERMINAL_DELIVERY_STATUS, LEG_1_COMPLETE_STATUS] },
        'updatedBy.uid': riderUid,
        ...(since ? { eventTime: { $gte: since } } : {}),
      },
    },
    { $sort: { eventTime: -1, createdAt: -1 } },
    {
      $group: {
        // Group on parcel + status, not just parcel: if the same rider somehow
        // ran both legs of one parcel, each leg is a separate piece of paid
        // work and collapsing them would silently drop one payout.
        _id: { parcel: '$parcel', status: '$status' },
        deliveredAt: { $first: '$eventTime' },
      },
    },
  ])

  if (!statuses.length) return []

  const parcels = await Parcel.find({
    _id: { $in: statuses.map((entry) => entry._id.parcel) },
  })

  const parcelsById = new Map(parcels.map((parcel) => [String(parcel._id), parcel]))

  return statuses
    .map(({ _id, deliveredAt }) => {
      const parcel = parcelsById.get(String(_id.parcel))
      return parcel ? { parcel, deliveredAt, status: _id.status } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.deliveredAt - a.deliveredAt)
}

/**
 * How many deliveries this rider completed at or after `since`.
 *
 * Used to evaluate the daily bonus, so it must count the same population
 * `listCompletedDeliveries` returns - both `delivered` and `at-godown` endings.
 */
export const countCompletedDeliveries = async (riderUid, since) => {
  if (!since) return 0

  const rows = await Tracking.aggregate([
    {
      $match: {
        status: { $in: [TERMINAL_DELIVERY_STATUS, LEG_1_COMPLETE_STATUS] },
        'updatedBy.uid': riderUid,
        eventTime: { $gte: since },
      },
    },
    { $group: { _id: '$parcel' } },
    { $count: 'total' },
  ])

  return rows[0]?.total || 0
}

/**
 * One delivery this rider finished, looked up by parcel.
 *
 * Deliberately the same predicate `listCompletedDeliveries` uses - the Tracking
 * log, not `assignedRider.uid` - so the receipt behind an earnings row and the
 * row itself can never disagree about whether this rider did the work.
 *
 * The single-event equivalent of loading the whole history and filtering it
 * client-side: opening a receipt must not pull every parcel a rider has ever
 * touched just to find one.
 *
 * @param {string} riderUid
 * @param {string} parcelId
 * @returns {Promise<{parcel: object, deliveredAt: Date, status: string}|null>}
 */
export const findCompletedDelivery = async (riderUid, parcelId) => {
  const event = await Tracking.findOne({
    status: { $in: [TERMINAL_DELIVERY_STATUS, LEG_1_COMPLETE_STATUS] },
    'updatedBy.uid': riderUid,
    parcel: parcelId,
  })
    .sort({ eventTime: -1, createdAt: -1 })
    .lean()

  if (!event) return null

  const parcel = await Parcel.findById(parcelId)
  if (!parcel) return null

  return { parcel, deliveredAt: event.eventTime, status: event.status }
}

/**
 * Appends a tracking event.
 *
 * @param {object} input
 * @returns {Promise<object>} The created event.
 */
export const appendTrackingEvent = async ({ parcel, status, message = '', updatedBy }) => {
  if (!TRACKING_STATUSES.includes(status)) {
    throw Object.assign(new Error(`status must be one of: ${TRACKING_STATUSES.join(', ')}`), {
      statusCode: 400,
    })
  }

  return Tracking.create({
    parcel: parcel._id,
    trackingId: parcel.trackingId,
    status,
    location: '',
    message,
    eventTime: new Date(),
    updatedBy,
  })
}
