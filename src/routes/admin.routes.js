import express from 'express';
import {
  getAdminStats,
  updateRiderPayout,
  listRiderPayouts,
  handoffParcel,
  verifyRiderDocument,
  getAdminAnalytics,
  getAdminPerformance,
  exportAdminData,
  getAdminActivityLog,
  createAnnouncement,
  getAdminAnnouncements,
  updateAnnouncement,
  deleteAnnouncement,
} from '../controllers/admin.controller.js';
import verifyToken from '../middleware/verifyToken.js';
import { verifyAdmin } from '../middleware/verifyAdmin.js';
import asyncHandler from '../middleware/asyncHandler.js';

const router = express.Router();

// All admin routes require token AND admin role
router.get('/stats', verifyToken, verifyAdmin, getAdminStats);

// Rider settlement worklist (read) and per-leg settlement writes.
router.get('/rider-payouts', verifyToken, verifyAdmin, asyncHandler(listRiderPayouts));
router.patch('/rider-payouts/:parcelId', verifyToken, verifyAdmin, asyncHandler(updateRiderPayout));

// Staff flips a cross-district parcel from leg 1 to leg 2 once it reaches the
// destination godown. This is the moment the delivery job becomes claimable.
router.patch('/parcels/:parcelId/handoff', verifyToken, verifyAdmin, asyncHandler(handoffParcel));

// Admin verifies or rejects a rider's document.
router.patch('/rider-documents/:userId/:documentType', verifyToken, verifyAdmin, asyncHandler(verifyRiderDocument));

// Admin analytics
router.get('/analytics', verifyToken, verifyAdmin, asyncHandler(getAdminAnalytics));

// Delivery performance detail: per-rider SLA, duration distribution, cancellations.
router.get('/performance', verifyToken, verifyAdmin, asyncHandler(getAdminPerformance));

// Data export (CSV or JSON) for users, parcels, payments and payouts.
router.get('/export/:resource', verifyToken, verifyAdmin, asyncHandler(exportAdminData));

// Admin activity log
router.get('/activity-log', verifyToken, verifyAdmin, asyncHandler(getAdminActivityLog));

// Admin announcements
router.get('/announcements', verifyToken, verifyAdmin, asyncHandler(getAdminAnnouncements));
router.post('/announcements', verifyToken, verifyAdmin, asyncHandler(createAnnouncement));
router.patch('/announcements/:id', verifyToken, verifyAdmin, asyncHandler(updateAnnouncement));
router.delete('/announcements/:id', verifyToken, verifyAdmin, asyncHandler(deleteAnnouncement));

export default router;