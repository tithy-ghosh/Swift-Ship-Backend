import express from 'express';
import { getAdminStats } from '../controllers/admin.controller.js';
import verifyToken from '../middleware/verifyToken.js';
import { verifyAdmin } from '../middleware/verifyAdmin.js';

const router = express.Router();

// All admin routes require token AND admin role
router.get('/stats', verifyToken, verifyAdmin, getAdminStats);

export default router;