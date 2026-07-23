import Parcel from '../models/parcel.model.js'
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

  return Parcel.findOneAndUpdate(
    { transactionId },
    {
      paymentStatus: 'paid',
      sslTransactionId: validationId,
      paidAmount: validation.amount,
      paidAt: new Date(),
    },
    { new: true }
  )
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
  result.parcel.transactionId = transactionId
  result.parcel.paymentMethod = 'online'
  await result.parcel.save()

  const gatewayUrl = await createPaymentSession(result.parcel, req.user, transactionId)
  return res.json({ gatewayUrl })
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

  result.parcel.paymentMethod = paymentMethod
  if (paymentMethod === 'cod') {
    result.parcel.paymentStatus = 'pending'
  }
  await result.parcel.save()

  return res.json({ success: true, parcel: result.parcel })
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
      getPaymentRedirectUrl({ payment: 'success', tracking: parcel.trackingId })
    )
  } catch (error) {
    console.error('Payment success callback failed:', error)
    return res.redirect(getPaymentRedirectUrl({ payment: 'error' }))
  }
}

/** POST /api/payment/fail */
export const handlePaymentFailure = async (req, res) => {
  if (req.body.tran_id) {
    await Parcel.findOneAndUpdate(
      { transactionId: req.body.tran_id },
      { paymentStatus: 'failed' }
    )
  }

  return res.redirect(getPaymentRedirectUrl({ payment: 'failed' }))
}

/** POST /api/payment/cancel */
export const handlePaymentCancellation = async (req, res) => {
  if (req.body.tran_id) {
    await Parcel.findOneAndUpdate(
      { transactionId: req.body.tran_id },
      { paymentStatus: 'cancelled' }
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
