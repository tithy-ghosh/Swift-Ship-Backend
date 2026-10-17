import express from 'express';
import {
  submitMerchantApplication,
  getAllMerchantApplications,
  approveMerchantApplication,
  rejectMerchantApplication,
  deactivateMerchantApplication,
} from '../controllers/merchantApplication.controller.js';
import verifyToken from '../middleware/verifyToken.js';
import { verifyAdmin } from '../middleware/verifyAdmin.js';
import asyncHandler from '../middleware/asyncHandler.js';

const router = express.Router();

// Any logged-in user can apply to become a merchant.
router.post('/', verifyToken, asyncHandler(submitMerchantApplication));

// Admin-only review queue.
router.get('/', verifyToken, verifyAdmin, asyncHandler(getAllMerchantApplications));
router.put('/:id/approve', verifyToken, verifyAdmin, asyncHandler(approveMerchantApplication));
router.put('/:id/reject', verifyToken, verifyAdmin, asyncHandler(rejectMerchantApplication));
router.put('/:id/deactivate', verifyToken, verifyAdmin, asyncHandler(deactivateMerchantApplication));

export default router;
