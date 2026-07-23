import mongoose from 'mongoose'

export const TRACKING_STATUSES = [
  'pending',
  'assigned',
  'picked-up',
  'in-transit',
  'out-for-delivery',
  'delivered',
  'cancelled',
]

const trackingSchema = new mongoose.Schema(
  {
    parcel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parcel',
      required: true,
      index: true,
    },
    trackingId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    status: { type: String, enum: TRACKING_STATUSES, required: true },
    location: { type: String, trim: true, default: '' },
    message: { type: String, trim: true, default: '' },
    eventTime: { type: Date, default: Date.now, index: true },
    updatedBy: {
      uid: { type: String, required: true },
      name: { type: String, default: '' },
    },
  },
  { timestamps: true }
)

trackingSchema.index({ trackingId: 1, eventTime: -1, createdAt: -1 })

export default mongoose.model('Tracking', trackingSchema)
