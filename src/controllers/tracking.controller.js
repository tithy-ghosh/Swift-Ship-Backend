import Parcel from '../models/parcel.model.js'
import Tracking, { TRACKING_STATUSES } from '../models/tracking.model.js'

const TRACKING_STATUS_SET = new Set(TRACKING_STATUSES)
const normalizeTrackingId = (value) => String(value || '').trim().toUpperCase()
const getTrackingId = (req) =>
  normalizeTrackingId(req.params.trackingId || req.query.trackingId)

export const getTrackingHistory = async (req, res) => {
  const trackingId = getTrackingId(req)
  if (!trackingId) {
    return res.status(400).json({ error: 'trackingId is required' })
  }

  const parcel = await Parcel.findOne({ trackingId }).select(
    'trackingId deliveryZone senderServiceCenter receiverServiceCenter createdAt'
  )
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  const events = await Tracking.find({ parcel: parcel._id })
    .select('status location message eventTime createdAt')
    .sort({ eventTime: -1, createdAt: -1 })
    .lean()

  return res.json({
    parcel,
    currentStatus: events[0]?.status || null,
    events,
  })
}

// Tracking history is append-only: every status update creates a new document.
export const addTrackingEvent = async (req, res) => {
  const trackingId = getTrackingId(req)
  const { status, location = '', message = '', eventTime } = req.body

  if (!TRACKING_STATUS_SET.has(status)) {
    return res.status(400).json({
      error: `status must be one of: ${TRACKING_STATUSES.join(', ')}`,
    })
  }

  const parsedEventTime = eventTime ? new Date(eventTime) : new Date()
  if (Number.isNaN(parsedEventTime.getTime())) {
    return res.status(400).json({ error: 'eventTime must be a valid date' })
  }

  const parcel = await Parcel.findOne({ trackingId }).select('_id trackingId')
  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  const event = await Tracking.create({
    parcel: parcel._id,
    trackingId: parcel.trackingId,
    status,
    location,
    message,
    eventTime: parsedEventTime,
    updatedBy: { uid: req.user.uid, name: req.staffUser.name },
  })

  return res.status(201).json(event)
}
