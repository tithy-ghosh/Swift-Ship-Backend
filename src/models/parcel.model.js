import mongoose from 'mongoose'

const parcelSchema = new mongoose.Schema(
  {
    trackingId: {
      type: String,
      required: true,
      unique: true,
    },
    type: {
      type: String,
      enum: ['document', 'non-document'],
      required: true,
    },
    title: {
      type: String,
      default: '',
    },
    weight: {
      type: Number,
      default: 0,
    },

    // Sender
    senderName: { type: String, required: true },
    senderContact: { type: String, required: true },
    senderRegion: { type: String, required: true },
    senderServiceCenter: { type: String, required: true },
    senderAddress: { type: String, default: '' },
    pickupInstruction: { type: String, default: '' },

    // Receiver
    receiverName: { type: String, required: true },
    receiverContact: { type: String, required: true },
    receiverRegion: { type: String, required: true },
    receiverServiceCenter: { type: String, required: true },
    receiverAddress: { type: String, default: '' },
    deliveryInstruction: { type: String, default: '' },

    // Pricing
    deliveryCost: { type: Number, required: true },
    deliveryZone: { type: String, required: true },
    costBreakdown: [
      {
        label: String,
        amount: Number,
      },
    ],

    // Status
    status: {
      type: String,
      enum: ['pending', 'assigned', 'picked-up', 'in-transit', 'delivered', 'cancelled'],
      default: 'pending',
    },

    // Owner
    createdBy: {
      uid: { type: String, required: true },
      name: { type: String },
      email: { type: String },
    },
    paymentMethod: { type: String, enum: ['online', 'cod'], required: true },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'cancelled'], default: 'pending' },
    transactionId: { type: String, unique: true, sparse: true }, // your internal tran_id
    sslTransactionId: { type: String }, // val_id after validation
    paidAmount: { type: Number },
    paidAt: { type: Date }
  },
  { timestamps: true }
)

const Parcel = mongoose.model('Parcel', parcelSchema)

export default Parcel