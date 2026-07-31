import express from 'express'
import { createUser, getCurrentUser, updateProfile } from '../controllers/user.controller.js'
import asyncHandler from '../middleware/asyncHandler.js'
import verifyToken from '../middleware/verifyToken.js'

const router = express.Router()

router.post('/', verifyToken, asyncHandler(createUser))
router.get('/me', verifyToken, asyncHandler(getCurrentUser))
router.put('/me', verifyToken, asyncHandler(updateProfile))
export default router
