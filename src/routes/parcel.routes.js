import express from 'express'
import {
  createParcel,
  createQuote,
  deleteParcel,
  listMyParcels,
  trackParcel,
} from '../controllers/parcel.controller.js'
import asyncHandler from '../middleware/asyncHandler.js'
import verifyToken from '../middleware/verifyToken.js'

const router = express.Router()

router.post('/quote', verifyToken, asyncHandler(createQuote))
router.post('/', verifyToken, asyncHandler(createParcel))
router.get('/my', verifyToken, asyncHandler(listMyParcels))
router.get('/track/:trackingId', asyncHandler(trackParcel))
router.delete('/:id', verifyToken, asyncHandler(deleteParcel))

export default router
