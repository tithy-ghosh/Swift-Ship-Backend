import express from 'express'
import verifyToken from '../middleware/verifyToken.js'
import {
  initPayment,
  setPaymentMethod,
  paymentSuccess,
  paymentFail,
  paymentCancel,
  paymentIPN,
} from '../controller/payment.controller.js'

const router = express.Router()

// User-initiated — require a valid Firebase token
router.post('/init/:parcelId', verifyToken, initPayment)
router.post('/method/:parcelId', verifyToken, setPaymentMethod)

// SSLCommerz server-to-server / browser-redirect callbacks — no auth header, don't verifyToken
router.post('/success', paymentSuccess)
router.post('/fail', paymentFail)
router.post('/cancel', paymentCancel)
router.post('/ipn', paymentIPN)

export default router