import express from 'express'
import {
  cancelMerchantParcel,
  cancelMerchantPickup,
  createBulkParcels,
  createMerchantPickup,
  createMerchantReturn,
  createPickupAddress,
  deletePickupAddress,
  exportMerchantParcels,
  exportMerchantPayments,
  getBulkTemplate,
  getCodLedger,
  getMerchantAnnouncements,
  getMerchantParcel,
  getMerchantParcels,
  getMerchantPickups,
  getMerchantProfile,
  getMerchantRemittance,
  getMerchantRemittances,
  getMerchantSummary,
  previewBulkParcels,
  updateMerchantParcelReceiver,
  updateMerchantProfile,
  updatePickupAddress,
} from '../controllers/merchant.controller.js'
import verifyToken from '../middleware/verifyToken.js'
import requireMerchant from '../middleware/requireMerchant.js'
import asyncHandler from '../middleware/asyncHandler.js'
import { createRateLimiter } from '../middleware/rateLimit.js'

const router = express.Router()

// Bulk uploads are the heaviest merchant surface (parsing, pricing, creation),
// so they carry their own leash. Previews are cheap and repeatable while a
// merchant fixes their file; commits write hundreds of documents.
const bulkPreviewLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })
const bulkCommitLimiter = createRateLimiter({ windowMs: 60_000, max: 6 })

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

// `/parcels/export` and the `bulk` literals are declared before `/parcels/:id`
// so the literal paths win.
router.get('/parcels/export', asyncHandler(exportMerchantParcels))
router.get('/parcels/bulk/template', asyncHandler(getBulkTemplate))
router.post('/parcels/bulk', bulkPreviewLimiter, asyncHandler(previewBulkParcels))
router.post('/parcels/bulk/commit', bulkCommitLimiter, asyncHandler(createBulkParcels))
router.get('/parcels', asyncHandler(getMerchantParcels))
router.get('/parcels/:id', asyncHandler(getMerchantParcel))
router.patch('/parcels/:id/receiver', asyncHandler(updateMerchantParcelReceiver))
router.patch('/parcels/:id/cancel', asyncHandler(cancelMerchantParcel))
router.post('/parcels/:id/return', asyncHandler(createMerchantReturn))

// Pickups and the pickup address book (Feature 5).
router.get('/pickups', asyncHandler(getMerchantPickups))
router.post('/pickups', asyncHandler(createMerchantPickup))
router.patch('/pickups/:id/cancel', asyncHandler(cancelMerchantPickup))
router.post('/pickup-addresses', asyncHandler(createPickupAddress))
router.patch('/pickup-addresses/:id', asyncHandler(updatePickupAddress))
router.delete('/pickup-addresses/:id', asyncHandler(deletePickupAddress))

export default router
