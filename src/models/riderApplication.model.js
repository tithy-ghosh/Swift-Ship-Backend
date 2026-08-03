import mongoose from 'mongoose';

const riderApplicationSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true, // Firebase UID
    },
    name: { type: String, required: true },
    email: { type: String, required: true },
    age: { type: Number, required: true, min: 18 },
    region: { type: String, required: true },
    district: { type: String, required: true },
    phone: { type: String, required: true },
    nid: { type: String, required: true }, // National ID
    bikeBrand: { type: String, required: true },
    bikeRegNumber: { type: String, required: true },
    licenseNumber: { type: String, required: true }, // Added relevant field
    experience: { type: Number, default: 0 }, // Years of experience
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending', 
    },
    adminNotes: { type: String, default: '' },
  },
  { timestamps: true }
);

const RiderApplication = mongoose.model('RiderApplication', riderApplicationSchema);
export default RiderApplication;