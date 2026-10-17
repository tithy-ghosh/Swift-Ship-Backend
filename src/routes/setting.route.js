import express from 'express';
import {
  getSettings,
  updateSettings,
  updatePricingSettings,
  updateRiderPayoutSettings,
  updateSystemSettings,
  getPublicSettings,
  createZone,
  updateZone,
  deleteZone,
} from '../controllers/setting.controller.js';
import asyncHandler from '../middleware/asyncHandler.js';
import verifyToken from '../middleware/verifyToken.js';
import { verifyAdmin } from '../middleware/verifyAdmin.js';

const router = express.Router();

// Public routes
router.get('/public', asyncHandler(getPublicSettings));

// Admin-only routes
router.get('/', verifyToken, verifyAdmin, asyncHandler(getSettings));
router.put('/', verifyToken, verifyAdmin, asyncHandler(updateSettings));
router.patch('/pricing', verifyToken, verifyAdmin, asyncHandler(updatePricingSettings));
router.patch('/rider-payout', verifyToken, verifyAdmin, asyncHandler(updateRiderPayoutSettings));
router.patch('/system', verifyToken, verifyAdmin, asyncHandler(updateSystemSettings));

// Service zone CRUD (admin only)
router.post('/zones', verifyToken, verifyAdmin, asyncHandler(createZone));
router.patch('/zones/:zoneId', verifyToken, verifyAdmin, asyncHandler(updateZone));
router.delete('/zones/:zoneId', verifyToken, verifyAdmin, asyncHandler(deleteZone));

export default router;