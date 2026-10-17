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
      enum: ['pending', 'approved', 'rejected', 'deactivated'],
      default: 'pending', 
    },
    adminNotes: { type: String, default: '' },

    // ---- Rider runtime state ----
    // An approved application doubles as the rider's operational record: it is
    // already 1:1 with the rider (name, district, vehicle, documents) and is
    // the only rider-shaped document in the database. A separate Rider model
    // would mean a third place to keep the same person's details in sync.

    /** Whether the rider is currently accepting jobs. */
    isOnline: { type: Boolean, default: false },
    /** Last time the rider app reported in. Used to spot stale online flags. */
    lastSeenAt: { type: Date, default: null },
    /**
     * Weekly availability schedule. One entry per day of the week (0 = Sunday).
     * Each entry lists time slots (start/end in minutes from midnight) when the
     * rider is willing to receive jobs. An empty or missing entry means the
     * rider does not work that day.
     */
    weeklySchedule: [
      {
        day: { type: Number, required: true, min: 0, max: 6 },
        slots: [
          {
            start: { type: Number, required: true, min: 0, max: 1440 },
            end: { type: Number, required: true, min: 0, max: 1440 },
          },
        ],
      },
    ],
    /**
     * The parcel this rider is currently delivering, if any. Enforced as the
     * "one active delivery per rider" rule in the accept endpoint.
     */
    currentParcel: { type: mongoose.Schema.Types.ObjectId, ref: 'Parcel', default: null },
    stats: {
      totalAccepted: { type: Number, default: 0 },
      totalCompleted: { type: Number, default: 0 },
      totalEarnings: { type: Number, default: 0 },
      totalCodCollected: { type: Number, default: 0 },
    },
    /**
     * Where earnings are sent. Display-only for v1 - nothing in the rider app
     * sets it, so an admin or a seed script populates it.
     */
    payoutDetails: {
      method: { type: String, enum: ['bkash', 'nagad'], default: 'bkash' },
      number: { type: String, default: '' },
    },

    /** Document verification status for onboarding. */
    documents: {
      nid: {
        url: { type: String, default: '' },
        status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
        rejectedAt: { type: Date, default: null },
        rejectedReason: { type: String, default: '' },
      },
      license: {
        url: { type: String, default: '' },
        status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
        rejectedAt: { type: Date, default: null },
        rejectedReason: { type: String, default: '' },
      },
      bikeRegistration: {
        url: { type: String, default: '' },
        status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
        rejectedAt: { type: Date, default: null },
        rejectedReason: { type: String, default: '' },
      },
    },
    /** Overall document verification state. */
    documentsStatus: {
      type: String,
      enum: ['pending', 'verified', 'rejected'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

// Every rider-scoped read filters on userId + status, so index both.
riderApplicationSchema.index({ userId: 1, status: 1 });

const RiderApplication = mongoose.model('RiderApplication', riderApplicationSchema);
export default RiderApplication;