import express from 'express';
import { submitRiderApplication, getAllRiderApplications, approveRiderApplication, rejectRiderApplication } from '../controllers/riderApplication.controller.js';
import verifyToken from '../middleware/verifyToken.js';
import { verifyAdmin } from '../middleware/verifyAdmin.js';
import asyncHandler from '../middleware/asyncHandler.js';

const router = express.Router();

// Public routes- any logged in user can apply
router.post('/', verifyToken, asyncHandler(submitRiderApplication));

// Admin only routes

router.get('/', verifyToken, verifyAdmin, asyncHandler(getAllRiderApplications))
router.put('/:id/approve', verifyToken, verifyAdmin, asyncHandler(approveRiderApplication))
router.put('/:id/reject', verifyToken, verifyAdmin, asyncHandler(rejectRiderApplication))

export default router;