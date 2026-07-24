import { createHash, randomBytes } from 'node:crypto'
import Parcel from '../models/parcel.model.js'
import Payment from '../models/payment.model.js'
import {
  createPaymentSession,
  getPaymentRedirectUrl,
  validatePayment,
} from '../services/payment.service.js'

const PAYMENT_METHODS = new Set(['online', 'cod'])
const CUSTOMER_PAYMENT_FIELDS =
  'parcel trackingId method status amount paidAmount paidAt createdAt updatedAt'

const hashCallbackToken = (token) =>
  createHash('sha256').update(String(token || '')).digest('hex')

const toCustomerPayment = (payment) => ({
  id: payment._id,
  parcel: payment.parcel,
  trackingId: payment.trackingId,
  method: payment.method,
  status: payment.status,
  amount: payment.amount,
  paidAmount: payment.paidAmount,
  paidAt: payment.paidAt,
  createdAt: payment.createdAt,
  updatedAt: payment.updatedAt,
})

const findOwnedParcel = async (parcelId, userId) => {
  const parcel = await Parcel.findById(parcelId)

  if (!parcel) {
    return { error: 'Parcel not found', statusCode: 404 }
  }
  if (parcel.createdBy.uid !== userId) {
    return { error: 'Not authorized for this parcel', statusCode: 403 }
  }

  return { parcel }
}

const markPaymentAsPaid = async (transactionId, validationId, callbackToken) => {
  const payment = await Payment.findOne({
    transactionId,
    callbackTokenHash: hashCallbackToken(callbackToken),
  }).select('_id')
  if (!payment) {
    return null
  }

  const validation = await validatePayment(validationId)
  if (!validation) {
    return null
  }

  return Payment.findByIdAndUpdate(
    payment._id,
    {
      status: 'paid',
      gatewayValidationId: validationId,
      paidAmount: validation.amount,
      paidAt: new Date(),
    },
    { new: true }
  ).populate(
    { path: 'parcel', select: 'trackingId' }
  )
}

/** GET /api/payment/:parcelId */
export const getPayment = async (req, res) => {
  const result = await findOwnedParcel(req.params.parcelId, req.user.uid)
  if (!result.parcel) {
    return res.status(result.statusCode).json({ error: result.error })
  }

  const payment = await Payment.findOne({ parcel: result.parcel._id }).select(
    CUSTOMER_PAYMENT_FIELDS
  )
  if (!payment) {
    return res.status(404).json({ error: 'Payment not found' })
  }

  return res.json(payment)
}

/**
 * GET /api/payment/history/my
 *
 * Returns only payments attached to parcels owned by the verified Firebase
 * user. Ownership is derived server-side and cannot be supplied by the client.
 */
export const getMyPaymentHistory = async (req, res) => {
  const requestedPage = Number.parseInt(req.query.page, 10)
  const requestedLimit = Number.parseInt(req.query.limit, 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 50)
      : 20

  const ownedParcelIds = await Parcel.find({ 'createdBy.uid': req.user.uid }).distinct('_id')
  if (!ownedParcelIds.length) {
    return res.json({
      payments: [],
      pagination: { page, limit, total: 0, pages: 0 },
      summary: { totalPaid: 0, completedPayments: 0 },
    })
  }

  const filter = { parcel: { $in: ownedParcelIds } }
  const [payments, total, summaryRows] = await Promise.all([
    Payment.find(filter)
      .select(CUSTOMER_PAYMENT_FIELDS)
      .sort({ paidAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Payment.countDocuments(filter),
    Payment.aggregate([
      { $match: { ...filter, status: 'paid' } },
      {
        $group: {
          _id: null,
          totalPaid: { $sum: { $ifNull: ['$paidAmount', '$amount'] } },
          completedPayments: { $sum: 1 },
        },
      },
    ]),
  ])
  const summary = summaryRows[0] || { totalPaid: 0, completedPayments: 0 }

  return res.json({
    payments: payments.map((payment) => ({
      id: payment._id,
      parcel: payment.parcel,
      trackingId: payment.trackingId,
      method: payment.method,
      status: payment.status,
      amount: payment.amount,
      paidAmount: payment.paidAmount,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    })),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
    summary: {
      totalPaid: summary.totalPaid,
      completedPayments: summary.completedPayments,
    },
  })
}

/**
 * POST /api/payment/init/:parcelId
 *
 * Creates an SSLCommerz sandbox session for a parcel owned by the authenticated
 * user. The returned URL is where the frontend should navigate the browser.
 */
export const initializePayment = async (req, res) => {
  const result = await findOwnedParcel(req.params.parcelId, req.user.uid)
  if (!result.parcel) {
    return res.status(result.statusCode).json({ error: result.error })
  }

  const transactionId = `SWFT-${result.parcel._id}-${Date.now()}`
  const callbackToken = randomBytes(32).toString('hex')
  const payment = await Payment.findOneAndUpdate(
    { parcel: result.parcel._id },
    {
      $set: {
        trackingId: result.parcel.trackingId,
        method: 'online',
        status: 'pending',
        transactionId,
        callbackTokenHash: hashCallbackToken(callbackToken),
        amount: result.parcel.deliveryCost,
      },
    },
    { new: true, upsert: true, runValidators: true }
  )

  const gatewayUrl = await createPaymentSession(
    result.parcel,
    req.user,
    transactionId,
    callbackToken
  )
  return res.json({ gatewayUrl, paymentId: payment._id, transactionId })
}

/** POST /api/payment/method/:parcelId */
export const updatePaymentMethod = async (req, res) => {
  const { paymentMethod } = req.body

  if (!PAYMENT_METHODS.has(paymentMethod)) {
    return res.status(400).json({ error: 'paymentMethod must be online or cod' })
  }

  const result = await findOwnedParcel(req.params.parcelId, req.user.uid)
  if (!result.parcel) {
    return res.status(result.statusCode).json({ error: result.error })
  }

  const payment = await Payment.findOneAndUpdate(
    { parcel: result.parcel._id },
    {
      $set: {
        trackingId: result.parcel.trackingId,
        method: paymentMethod,
        status: 'pending',
        amount: result.parcel.deliveryCost,
      },
      ...(paymentMethod === 'cod'
        ? {
            $unset: {
              transactionId: 1,
              callbackTokenHash: 1,
              gatewayValidationId: 1,
              paidAt: 1,
              paidAmount: 1,
            },
          }
        : {}),
    },
    { new: true, upsert: true, runValidators: true }
  )

  return res.json({ success: true, payment: toCustomerPayment(payment) })
}

/**
 * POST /api/payment/success
 *
 * SSLCommerz posts a form-encoded browser callback. The callback is not trusted
 * until its val_id has been verified with SSLCommerz server-to-server.
 */
export const handlePaymentSuccess = async (req, res) => {
  try {
    const { tran_id: transactionId, val_id: validationId } = req.body

    if (!transactionId || !validationId) {
      return res.redirect(getPaymentRedirectUrl({ payment: 'invalid' }))
    }

    const parcel = await markPaymentAsPaid(transactionId, validationId, req.query.token)
    if (!parcel) {
      return res.redirect(getPaymentRedirectUrl({ payment: 'invalid' }))
    }

    return res.redirect(
      getPaymentRedirectUrl({ payment: 'success', tracking: parcel.parcel.trackingId })
    )
  } catch (error) {
    console.error('Payment success callback failed:', error)
    return res.redirect(getPaymentRedirectUrl({ payment: 'error' }))
  }
}

/** POST /api/payment/fail */
export const handlePaymentFailure = async (req, res) => {
  if (req.body.tran_id && req.query.token) {
    const payment = await Payment.findOneAndUpdate(
      {
        transactionId: req.body.tran_id,
        callbackTokenHash: hashCallbackToken(req.query.token),
      },
      { status: 'failed' }
    )
    if (!payment) {
      return res.redirect(getPaymentRedirectUrl({ payment: 'invalid' }))
    }
  } else {
    return res.redirect(getPaymentRedirectUrl({ payment: 'invalid' }))
  }

  return res.redirect(getPaymentRedirectUrl({ payment: 'failed' }))
}

/** POST /api/payment/cancel */
export const handlePaymentCancellation = async (req, res) => {
  if (req.body.tran_id && req.query.token) {
    const payment = await Payment.findOneAndUpdate(
      {
        transactionId: req.body.tran_id,
        callbackTokenHash: hashCallbackToken(req.query.token),
      },
      { status: 'cancelled' }
    )
    if (!payment) {
      return res.redirect(getPaymentRedirectUrl({ payment: 'invalid' }))
    }
  } else {
    return res.redirect(getPaymentRedirectUrl({ payment: 'invalid' }))
  }

  return res.redirect(getPaymentRedirectUrl({ payment: 'cancelled' }))
}

/**
 * POST /api/payment/ipn
 *
 * Processes SSLCommerz's server-to-server Instant Payment Notification. This
 * acts as the source of truth when the customer's browser never returns.
 */
export const handlePaymentIpn = async (req, res) => {
  const { tran_id: transactionId, val_id: validationId, status } = req.body

  if (status === 'VALID' && transactionId && validationId && req.query.token) {
    await markPaymentAsPaid(transactionId, validationId, req.query.token)
  }

  return res.status(200).send('IPN received')
}
