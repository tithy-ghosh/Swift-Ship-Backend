import express from 'express';
import {
  getSettings,
  updateSettings,
  updatePricingSettings,
  updateSystemSettings,
  getPublicSettings,
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
router.patch('/system', verifyToken, verifyAdmin, asyncHandler(updateSystemSettings));

export default router;