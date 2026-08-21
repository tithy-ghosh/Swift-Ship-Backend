import express from 'express'
import { createUser, getCurrentUser, updateProfile, getAllUsers, deleteUser } from '../controllers/user.controller.js'
import asyncHandler from '../middleware/asyncHandler.js'
import verifyToken from '../middleware/verifyToken.js'
import { verifyAdmin } from '../middleware/verifyAdmin.js'

const router = express.Router()
//Regular user routes
router.post('/', verifyToken, asyncHandler(createUser))
router.get('/me', verifyToken, asyncHandler(getCurrentUser))
router.put('/me', verifyToken, asyncHandler(updateProfile))
//Admin only routes

router.get('/', verifyToken, verifyAdmin, asyncHandler(getAllUsers));
router.delete('/:id', verifyToken, verifyAdmin, asyncHandler(deleteUser));

export default router
