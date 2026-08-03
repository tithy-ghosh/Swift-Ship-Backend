import express from 'express';
import { submitRiderApplication } from '../controllers/riderApplication.controller.js';
import verifyToken from '../middleware/verifyToken.js';
import asyncHandler from '../middleware/asyncHandler.js';

const router = express.Router();

router.post('/', verifyToken, asyncHandler(submitRiderApplication));

export default router;