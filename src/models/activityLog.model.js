import mongoose from 'mongoose'

const activityLogSchema = new mongoose.Schema(
  {
    actorUid: {
      type: String,
      required: true,
      index: true, // Firebase UID of the admin who performed the action
    },
    actorName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true, // e.g. "approve_rider", "settle_payout", "verify_document"
    },
    targetType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
      index: true, // e.g. "rider", "merchant", "parcel", "payment", "user"
    },
    targetId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    targetName: {
      type: String,
      trim: true,
      maxlength: 200,
      default: '',
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
)

activityLogSchema.index({ createdAt: -1 })

// Compound index for common queries: filter by action and date range
activityLogSchema.index({ action: 1, createdAt: -1 })
activityLogSchema.index({ targetType: 1, createdAt: -1 })

const ActivityLog = mongoose.model('ActivityLog', activityLogSchema)
export default ActivityLog
