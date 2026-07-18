import express from 'express'
import Parcel from '../models/parcel.model.js'
import verifyToken from '../middleware/verifyToken.js'

const router = express.Router()

// ── Helpers ──

const generateTrackingId = () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `SS-${date}-${randomPart}`
}

const calculateDeliveryCharge = ({ type, weight, senderServiceCenter, receiverServiceCenter }) => {
  const parcelWeight = Number(weight) || 1
  const isWithinCity = senderServiceCenter === receiverServiceCenter
  const deliveryZone = isWithinCity ? 'Within City' : 'Outside City/District'

  if (type === 'document') {
    const deliveryCost = isWithinCity ? 50 : 80
    return {
      deliveryCost,
      deliveryZone,
      costBreakdown: [{ label: `Document delivery (${deliveryZone})`, amount: deliveryCost }],
    }
  }

  const baseCost = isWithinCity ? 80 : 130

  if (parcelWeight <= 3) {
    return {
      deliveryCost: baseCost,
      deliveryZone,
      costBreakdown: [
        { label: `Non-document base charge up to 3 kg (${deliveryZone})`, amount: baseCost },
      ],
    }
  }

  const extraWeight = Math.ceil(parcelWeight - 3)
  const extraWeightCost = extraWeight * 20
  const outsideCityCharge = isWithinCity ? 0 : 20
  const deliveryCost = baseCost + extraWeightCost + outsideCityCharge

  const costBreakdown = [
    { label: `Non-document base charge up to 3 kg (${deliveryZone})`, amount: baseCost },
    { label: `Extra weight charge (${extraWeight} kg x BDT 20)`, amount: extraWeightCost },
  ]
  if (outsideCityCharge) {
    costBreakdown.push({ label: 'Outside city/district charge', amount: outsideCityCharge })
  }

  return { deliveryCost, deliveryZone, costBreakdown }
}

// ── Routes ──

// POST /api/parcels/quote
// Calculate delivery charge before confirming — no DB write
router.post('/quote', verifyToken, async (req, res) => {
  try {
    const { type, weight, senderServiceCenter, receiverServiceCenter } = req.body

    if (!type || !senderServiceCenter || !receiverServiceCenter) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const { deliveryCost, deliveryZone, costBreakdown } = calculateDeliveryCharge({
      type, weight, senderServiceCenter, receiverServiceCenter,
    })

    const trackingId = generateTrackingId()

    res.json({ trackingId, deliveryCost, deliveryZone, costBreakdown })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/parcels
// Save confirmed parcel to MongoDB
router.post('/', verifyToken, async (req, res) => {
  try {
    const {
      trackingId, type, title, weight,
      senderName, senderContact, senderRegion, senderServiceCenter, senderAddress, pickupInstruction,
      receiverName, receiverContact, receiverRegion, receiverServiceCenter, receiverAddress, deliveryInstruction,
    } = req.body

    if (!trackingId || !type || !senderName || !receiverName) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Recalculate price on the server — never trust what the client sends
    const { deliveryCost, deliveryZone, costBreakdown } = calculateDeliveryCharge({
      type, weight, senderServiceCenter, receiverServiceCenter,
    })

    const parcel = await Parcel.create({
      trackingId,
      type,
      title,
      weight,
      senderName, senderContact, senderRegion, senderServiceCenter, senderAddress, pickupInstruction,
      receiverName, receiverContact, receiverRegion, receiverServiceCenter, receiverAddress, deliveryInstruction,
      deliveryCost,
      deliveryZone,
      costBreakdown,
      status: 'pending',
      createdBy: {
        uid: req.user.uid,
        email: req.user.email,
        name: senderName,
      },
    })

    res.status(201).json(parcel)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/parcels/my
// Get all parcels belonging to the logged-in user
router.get('/my', verifyToken, async (req, res) => {
  try {
    const parcels = await Parcel.find({ 'createdBy.uid': req.user.uid }).sort({ createdAt: -1 })
    res.json(parcels)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/parcels/track/:trackingId
// Public — anyone with a tracking ID can check status
router.get('/track/:trackingId', async (req, res) => {
  try {
    const parcel = await Parcel.findOne({ trackingId: req.params.trackingId }).select(
      'trackingId status deliveryZone senderServiceCenter receiverServiceCenter createdAt'
    )
    if (!parcel) return res.status(404).json({ error: 'Parcel not found' })
    res.json(parcel)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})
// DELETE /api/parcels/:id
// Delete a parcel — only the user who created it can delete it
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const parcel = await Parcel.findById(req.params.id)
 
    if (!parcel) {
      return res.status(404).json({ error: 'Parcel not found' })
    }
 
    if (parcel.createdBy.uid !== req.user.uid) {
      return res.status(403).json({ error: 'Not authorized to delete this parcel' })
    }
 
    await parcel.deleteOne()
 
    res.json({ message: 'Parcel deleted successfully' })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})
export default router