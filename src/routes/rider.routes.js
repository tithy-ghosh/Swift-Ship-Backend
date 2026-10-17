import express from 'express'

import verifyToken from '../middleware/verifyToken.js'
import requireRider from '../middleware/requireRider.js'
import asyncHandler from '../middleware/asyncHandler.js'
import {
  getRiderApplicationStatus,
  getRiderProfile,
  getEarnings,
  getRiderPayouts,
  requestRiderPayout,
  setAvailability,
  setSchedule,
  submitRiderRating,
  getRiderRatings,
  getRiderRatingsMe,
  submitRiderDocuments,
  getRiderDocuments,
  getActiveAnnouncements,
  listNearbyJobs,
  acceptJob,
  getActiveDelivery,
  getMyDelivery,
  updateDeliveryStatus,
  reportIssue,
  confirmCodCollected,
  handoverCod,
} from '../controllers/rider.controller.js'

/**
 * Rider-facing API, mounted at /api/rider.
 *
 * Every route is `verifyToken` + `requireRider`. The tracking endpoint's
 * staff-only access is deliberately NOT reused here: it lets any rider write a
 * status for any parcel, which is not something a rider app should be able to
 * do even by accident.
 */
const router = express.Router()

// Profile and availability
router.get('/profile', verifyToken, requireRider, asyncHandler(getRiderProfile))
router.patch('/availability', verifyToken, requireRider, asyncHandler(setAvailability))
router.patch('/schedule', verifyToken, requireRider, asyncHandler(setSchedule))

// Job offers
router.get('/jobs', verifyToken, requireRider, asyncHandler(listNearbyJobs))
router.post('/jobs/:parcelId/accept', verifyToken, requireRider, asyncHandler(acceptJob))

// The delivery in progress
router.get('/deliveries/active', verifyToken, requireRider, asyncHandler(getActiveDelivery))
// A finished delivery, for the receipt. Declared after `/active` so Express
// does not read the literal `active` as a parcel id.
router.get('/deliveries/:parcelId', verifyToken, requireRider, asyncHandler(getMyDelivery))
router.post(
  '/deliveries/:parcelId/status',
  verifyToken,
  requireRider,
  asyncHandler(updateDeliveryStatus)
)
router.post('/deliveries/:parcelId/issue', verifyToken, requireRider, asyncHandler(reportIssue))
router.post(
  '/deliveries/:parcelId/cod',
  verifyToken,
  requireRider,
  asyncHandler(confirmCodCollected)
)
// Cash handover, declared after collection: the two are distinct paths, so
// there is no ambiguity - ordering only keeps the delivery-time action first
// for a reader scanning the file top to bottom.
router.post(
  '/deliveries/:parcelId/cod/handover',
  verifyToken,
  requireRider,
  asyncHandler(handoverCod)
)

// Money
router.get('/earnings', verifyToken, requireRider, asyncHandler(getEarnings))

// Application status - any logged-in user can check their own application.
router.get('/application', verifyToken, asyncHandler(getRiderApplicationStatus))

// Payout requests - approved riders only.
router.get('/payouts', verifyToken, requireRider, asyncHandler(getRiderPayouts))
router.post('/payouts', verifyToken, requireRider, asyncHandler(requestRiderPayout))

// Document upload and verification
router.get('/documents', verifyToken, requireRider, asyncHandler(getRiderDocuments))
router.post('/documents', verifyToken, requireRider, asyncHandler(submitRiderDocuments))

// Ratings - public read for checking a rider, authenticated write for submitting.
router.get('/ratings', asyncHandler(getRiderRatings))
router.get('/ratings/me', verifyToken, asyncHandler(getRiderRatingsMe))
router.post('/ratings', verifyToken, asyncHandler(submitRiderRating))

// Announcements - any logged-in user can view active announcements.
router.get('/announcements/active', verifyToken, asyncHandler(getActiveAnnouncements))

export default router
