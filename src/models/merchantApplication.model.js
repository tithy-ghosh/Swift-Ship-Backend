import mongoose from 'mongoose';

const merchantApplicationSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true, // Firebase UID
    },
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    businessName: { type: String, required: true },
    businessType: { type: String, required: true },
    region: { type: String, required: true },
    district: { type: String, required: true },
    pickupAddress: { type: String, required: true },
    monthlyOrders: { type: String, default: '' },
    website: { type: String, default: '' },
    needsCOD: { type: Boolean, default: true },
    notes: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'deactivated'],
      default: 'pending',
    },
    adminNotes: { type: String, default: '' },
  },
  { timestamps: true }
);

const MerchantApplication = mongoose.model('MerchantApplication', merchantApplicationSchema);
export default MerchantApplication;
