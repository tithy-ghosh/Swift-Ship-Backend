import mongoose from 'mongoose'

const riderRatingSchema = new mongoose.Schema(
  {
    riderId: {
      type: String,
      required: true,
      index: true, // Firebase UID of the rider being rated
    },
    parcelId: {
      type: String,
      required: true,
      index: true,
    },
    customerId: {
      type: String,
      required: true,
      index: true, // Firebase UID of the customer who rated
    },
    customerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
)

// One rating per parcel per customer - a customer can't rate the same delivery twice.
riderRatingSchema.index({ parcelId: 1, customerId: 1 }, { unique: true })

const RiderRating = mongoose.model('RiderRating', riderRatingSchema)
export default RiderRating
