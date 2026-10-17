import mongoose from 'mongoose'

const payoutRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true, // Firebase UID
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'rejected'],
      default: 'pending',
    },
    method: {
      type: String,
      enum: ['bkash', 'nagad'],
      default: 'bkash',
    },
    number: {
      type: String,
      default: '',
    },
    requestedAt: {
      type: Date,
      default: Date.now,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    note: {
      type: String,
      default: '', // Admin note: payment reference or rejection reason
    },
  },
  { timestamps: true }
)

// One request at a time per rider: a pending request blocks a new one.
payoutRequestSchema.index({ userId: 1, status: 1 })

const PayoutRequest = mongoose.model('PayoutRequest', payoutRequestSchema)
export default PayoutRequest
