import mongoose from 'mongoose'

const paymentSchema = new mongoose.Schema(
  {
    parcel: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parcel',
      required: true,
      unique: true,
      index: true,
    },
    trackingId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    method: {
      type: String,
      enum: ['online', 'cod'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'cancelled', 'refunded'],
      default: 'pending',
      required: true,
    },
    transactionId: { type: String, unique: true, sparse: true },
    callbackTokenHash: { type: String, select: false },
    gatewayValidationId: String,
    amount: { type: Number, min: 0, required: true },
    paidAmount: { type: Number, min: 0 },
    paidAt: Date,
    refundedAt: Date,
    refundReason: { type: String, default: '' },
  },
  { timestamps: true }
)

// Revenue analytics filter on payment status over the day the money moved.
paymentSchema.index({ status: 1, paidAt: -1 })
// Unpaid-initiated payments are dated by createdAt instead.
paymentSchema.index({ createdAt: -1 })

export default mongoose.model('Payment', paymentSchema)
