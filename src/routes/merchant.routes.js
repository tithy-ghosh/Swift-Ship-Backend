import express from 'express'
import {
  cancelMerchantParcel,
  exportMerchantParcels,
  exportMerchantPayments,
  getCodLedger,
  getMerchantAnnouncements,
  getMerchantParcel,
  getMerchantParcels,
  getMerchantProfile,
  getMerchantRemittance,
  getMerchantRemittances,
  getMerchantSummary,
  updateMerchantParcelReceiver,
  updateMerchantProfile,
} from '../controllers/merchant.controller.js'
import verifyToken from '../middleware/verifyToken.js'
import requireMerchant from '../middleware/requireMerchant.js'
import asyncHandler from '../middleware/asyncHandler.js'

const router = express.Router()

// Every merchant endpoint requires a signed-in account with an approved
// merchant application, so the guard runs once for the whole router.
router.use(verifyToken, asyncHandler(requireMerchant))

router.get('/summary', asyncHandler(getMerchantSummary))
router.get('/profile', asyncHandler(getMerchantProfile))
router.patch('/profile', asyncHandler(updateMerchantProfile))
router.get('/announcements/active', asyncHandler(getMerchantAnnouncements))

// Money: the COD ledger, remittance batches and their exports.
router.get('/cod-ledger', asyncHandler(getCodLedger))
router.get('/remittances', asyncHandler(getMerchantRemittances))
router.get('/remittances/:id', asyncHandler(getMerchantRemittance))
router.get('/payments/export', asyncHandler(exportMerchantPayments))

// `/parcels/export` is declared before `/parcels/:id` so the literal path wins.
router.get('/parcels/export', asyncHandler(exportMerchantParcels))
router.get('/parcels', asyncHandler(getMerchantParcels))
router.get('/parcels/:id', asyncHandler(getMerchantParcel))
router.patch('/parcels/:id/receiver', asyncHandler(updateMerchantParcelReceiver))
router.patch('/parcels/:id/cancel', asyncHandler(cancelMerchantParcel))

export default router
