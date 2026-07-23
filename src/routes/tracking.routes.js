import express from 'express'
import {
  addTrackingEvent,
  getTrackingHistory,
} from '../controllers/tracking.controller.js'
import asyncHandler from '../middleware/asyncHandler.js'
import requireStaff from '../middleware/requireStaff.js'
import verifyToken from '../middleware/verifyToken.js'

const router = express.Router()

router.get('/', asyncHandler(getTrackingHistory))
router.get('/:trackingId', asyncHandler(getTrackingHistory))
router.post(
  '/:trackingId/events',
  verifyToken,
  asyncHandler(requireStaff),
  asyncHandler(addTrackingEvent)
)

export default router
