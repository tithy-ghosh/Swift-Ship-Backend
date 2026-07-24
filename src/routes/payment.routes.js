import express from 'express'
import {
  handlePaymentCancellation,
  handlePaymentFailure,
  handlePaymentIpn,
  handlePaymentSuccess,
  getPayment,
  getMyPaymentHistory,
  initializePayment,
  updatePaymentMethod,
} from '../controllers/payment.controller.js'
import asyncHandler from '../middleware/asyncHandler.js'
import verifyToken from '../middleware/verifyToken.js'

const router = express.Router()

// Customer-initiated operations require a verified Firebase identity.
router.get('/history/my', verifyToken, asyncHandler(getMyPaymentHistory))
router.get('/:parcelId', verifyToken, asyncHandler(getPayment))
router.post('/init/:parcelId', verifyToken, asyncHandler(initializePayment))
router.post('/method/:parcelId', verifyToken, asyncHandler(updatePaymentMethod))

// SSLCommerz callbacks cannot carry the customer's Firebase access token.
router.post('/success', asyncHandler(handlePaymentSuccess))
router.post('/fail', asyncHandler(handlePaymentFailure))
router.post('/cancel', asyncHandler(handlePaymentCancellation))
router.post('/ipn', asyncHandler(handlePaymentIpn))

export default router
