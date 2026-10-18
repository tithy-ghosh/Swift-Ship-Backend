import mongoose from 'mongoose'

/** Lifecycle: requested -> scheduled -> completed; requested -> cancelled. */
export const PICKUP_STATUSES = ['requested', 'scheduled', 'completed', 'cancelled']

const pickupRequestSchema = new mongoose.Schema(
  {
    merchantUid: {
      type: String,
      required: true, // Firebase UID of the requesting merchant
      index: true,
    },
    businessName: { type: String, required: true },
    addressLabel: { type: String, default: '' },
    region: { type: String, required: true },
    district: { type: String, required: true },
    address: { type: String, required: true },
    contactPhone: { type: String, required: true },
    date: {
      type: Date,
      required: true, // pickup day, anchored at 00:00 Asia/Dhaka
    },
    timeWindow: { type: String, required: true },
    parcelCount: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: PICKUP_STATUSES,
      default: 'requested',
    },
    notes: { type: String, default: '' },
    cancelReason: { type: String, default: '' },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
)

// The merchant's own pickups, newest pickup day first.
pickupRequestSchema.index({ merchantUid: 1, date: -1, createdAt: -1 })

const PickupRequest = mongoose.model('PickupRequest', pickupRequestSchema)

export default PickupRequest
