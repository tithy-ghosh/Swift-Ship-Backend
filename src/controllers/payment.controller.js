import Parcel from '../models/parcel.model.js'
import Payment from '../models/payment.model.js'
import {
  createPaymentSession,
  getPaymentRedirectUrl,
  validatePayment,
} from '../services/payment.service.js'

const PAYMENT_METHODS = new Set(['online', 'cod'])

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

const markPaymentAsPaid = async (transactionId, validationId) => {
  const validation = await validatePayment(validationId)
  if (!validation) {
    return null
  }

  return Payment.findOneAndUpdate(
    { transactionId },
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

  const payment = await Payment.findOne({ parcel: result.parcel._id })
  if (!payment) {
    return res.status(404).json({ error: 'Payment not found' })
  }

  return res.json(payment)
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
  const payment = await Payment.findOneAndUpdate(
    { parcel: result.parcel._id },
    {
      $set: {
        trackingId: result.parcel.trackingId,
        method: 'online',
        status: 'pending',
        transactionId,
        amount: result.parcel.deliveryCost,
      },
    },
    { new: true, upsert: true, runValidators: true }
  )

  const gatewayUrl = await createPaymentSession(result.parcel, req.user, transactionId)
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
        ? { $unset: { transactionId: 1, gatewayValidationId: 1, paidAt: 1, paidAmount: 1 } }
        : {}),
    },
    { new: true, upsert: true, runValidators: true }
  )

  return res.json({ success: true, payment })
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

    const parcel = await markPaymentAsPaid(transactionId, validationId)
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
  if (req.body.tran_id) {
    await Payment.findOneAndUpdate(
      { transactionId: req.body.tran_id },
      { status: 'failed' }
    )
  }

  return res.redirect(getPaymentRedirectUrl({ payment: 'failed' }))
}

/** POST /api/payment/cancel */
export const handlePaymentCancellation = async (req, res) => {
  if (req.body.tran_id) {
    await Payment.findOneAndUpdate(
      { transactionId: req.body.tran_id },
      { status: 'cancelled' }
    )
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

  if (status === 'VALID' && transactionId && validationId) {
    await markPaymentAsPaid(transactionId, validationId)
  }

  return res.status(200).send('IPN received')
}
