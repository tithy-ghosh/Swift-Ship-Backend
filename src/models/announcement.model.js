import mongoose from 'mongoose'

const announcementSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    target: {
      type: String,
      enum: ['rider', 'customer', 'merchant', 'all'],
      default: 'all',
      required: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    createdBy: {
      type: String,
      required: true, // Firebase UID of the admin who created it
      index: true,
    },
    createdByName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
  },
  { timestamps: true }
)

// Index for common queries: active announcements for a target
announcementSchema.index({ target: 1, isActive: 1, expiresAt: 1 })
announcementSchema.index({ createdAt: -1 })

const Announcement = mongoose.model('Announcement', announcementSchema)
export default Announcement
