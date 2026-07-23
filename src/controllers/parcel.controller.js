import Parcel from '../models/parcel.model.js'
import { calculateDeliveryCharge } from '../services/delivery-pricing.service.js'
import { generateTrackingId } from '../utils/tracking.js'

const PARCEL_TYPES = new Set(['document', 'non-document'])
const PAYMENT_METHODS = new Set(['cod', 'online'])

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

  const pricing = calculateDeliveryCharge({
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

  const pricing = calculateDeliveryCharge({
    type,
    weight,
    senderServiceCenter,
    receiverServiceCenter,
  })

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
    ...pricing,
    status: 'pending',
    paymentMethod,
    paymentStatus: 'pending',
    createdBy: {
      uid: req.user.uid,
      email: req.user.email,
      name: senderName,
    },
  })

  return res.status(201).json(parcel)
}

/** GET /api/parcels/my */
export const listMyParcels = async (req, res) => {
  const parcels = await Parcel.find({ 'createdBy.uid': req.user.uid }).sort({ createdAt: -1 })
  return res.json(parcels)
}

/** GET /api/parcels/track/:trackingId */
export const trackParcel = async (req, res) => {
  const parcel = await Parcel.findOne({ trackingId: req.params.trackingId }).select(
    'trackingId status deliveryZone senderServiceCenter receiverServiceCenter createdAt'
  )

  if (!parcel) {
    return res.status(404).json({ error: 'Parcel not found' })
  }

  return res.json(parcel)
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

  await parcel.deleteOne()
  return res.json({ message: 'Parcel deleted successfully' })
}
