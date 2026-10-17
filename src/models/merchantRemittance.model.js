import mongoose from 'mongoose'

export const REMITTANCE_STATUSES = ['pending', 'processing', 'paid']

/**
 * One settlement batch: the COD cash SwiftShip has collected for a merchant
 * and is paying out.
 *
 * This is deliberately separate from `Parcel.cod`, which tracks the rider ->
 * admin deposit. The two numbers describe different handovers (customer ->
 * rider -> SwiftShip vs SwiftShip -> merchant) and must never be summed
 * together; a parcel appears in a remittance only once its cash is in
 * SwiftShip's hands.
 *
 * Batches are created and settled by admins (a later admin scope, mirroring
 * rider payouts). Merchants get read-only access through
 * `/api/merchant/remittances`.
 */
const merchantRemittanceSchema = new mongoose.Schema(
  {
    merchantUid: {
      type: String,
      required: true, // Firebase UID of the merchant
      index: true,
    },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    parcelIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Parcel' }],
    grossCollected: { type: Number, required: true, min: 0, default: 0 },
    fees: { type: Number, required: true, min: 0, default: 0 },
    netPayable: { type: Number, required: true, min: 0, default: 0 },
    status: {
      type: String,
      enum: REMITTANCE_STATUSES,
      default: 'pending',
    },
    reference: { type: String, default: '' },
    paidAt: { type: Date, default: null },
    notes: { type: String, default: '' },
    createdBy: { type: String, default: '' }, // Firebase UID of the admin who recorded it
  },
  { timestamps: true }
)

// The merchant ledger reads "this merchant's batches by status, newest first".
merchantRemittanceSchema.index({ merchantUid: 1, status: 1, createdAt: -1 })

const MerchantRemittance = mongoose.model('MerchantRemittance', merchantRemittanceSchema)
export default MerchantRemittance
