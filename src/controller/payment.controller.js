import SSLCommerzPayment from 'sslcommerz-lts'
import Parcel from '../models/parcel.model.js'

const store_id = process.env.SSLCZ_STORE_ID
const store_passwd = process.env.SSLCZ_STORE_PASSWORD
const is_live = false // sandbox — flip to true (and use live creds) in production

// POST /api/payment/init/:parcelId
// Called once a parcel exists and the user picked "Pay Online"
export const initPayment = async (req, res) => {
  try {
    const parcel = await Parcel.findById(req.params.parcelId)
    if (!parcel) return res.status(404).json({ error: 'Parcel not found' })

    if (parcel.createdBy.uid !== req.user.uid) {
      return res.status(403).json({ error: 'Not authorized for this parcel' })
    }

    const tran_id = `SWFT-${parcel._id}-${Date.now()}`
    parcel.transactionId = tran_id
    parcel.paymentMethod = 'online'
    await parcel.save()

    const data = {
      total_amount: parcel.deliveryCost,
      currency: 'BDT',
      tran_id,
      success_url: `${process.env.BACKEND_URL}/api/payment/success`,
      fail_url: `${process.env.BACKEND_URL}/api/payment/fail`,
      cancel_url: `${process.env.BACKEND_URL}/api/payment/cancel`,
      ipn_url: `${process.env.BACKEND_URL}/api/payment/ipn`,
      shipping_method: 'Courier',
      product_name: 'Parcel Delivery',
      product_category: 'Delivery',
      product_profile: 'general',
      cus_name: parcel.senderName,
      cus_email: req.user.email || 'no-reply@swiftship.app',
      cus_add1: parcel.senderAddress || parcel.senderServiceCenter,
      cus_phone: parcel.senderContact,
      cus_city: parcel.senderServiceCenter,
      cus_country: 'Bangladesh',
      ship_name: parcel.receiverName,
      ship_add1: parcel.receiverAddress || parcel.receiverServiceCenter,
      ship_city: parcel.receiverServiceCenter,
      ship_country: 'Bangladesh',
    }

    const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live)
    const apiResponse = await sslcz.init(data)

    if (!apiResponse?.GatewayPageURL) {
      return res.status(502).json({ error: 'Payment gateway did not return a checkout URL' })
    }

    res.json({ gatewayUrl: apiResponse.GatewayPageURL })
  } catch (err) {
    console.error('SSLCommerz init error:', err)
    res.status(500).json({ error: 'Payment initialization failed' })
  }
}

// POST /api/payment/method/:parcelId
// Lets a user switch a parcel to COD after creation, if ever needed
export const setPaymentMethod = async (req, res) => {
  try {
    const { paymentMethod } = req.body
    const parcel = await Parcel.findById(req.params.parcelId)
    if (!parcel) return res.status(404).json({ error: 'Parcel not found' })

    if (parcel.createdBy.uid !== req.user.uid) {
      return res.status(403).json({ error: 'Not authorized for this parcel' })
    }

    parcel.paymentMethod = paymentMethod
    if (paymentMethod === 'cod') {
      parcel.paymentStatus = 'pending' // cleared later by delivery agent
    }
    await parcel.save()
    res.json({ success: true, parcel })
  } catch (err) {
    console.error('Set payment method error:', err)
    res.status(500).json({ error: 'Failed to set payment method' })
  }
}

// POST /api/payment/success — SSLCommerz redirects the browser here (form POST)
export const paymentSuccess = async (req, res) => {
  try {
    const { tran_id, val_id } = req.body
    const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live)
    const validation = await sslcz.validate({ val_id })

    if (validation.status === 'VALID' || validation.status === 'VALIDATED') {
      const parcel = await Parcel.findOneAndUpdate(
        { transactionId: tran_id },
        {
          paymentStatus: 'paid',
          sslTransactionId: val_id,
          paidAmount: validation.amount,
          paidAt: new Date(),
        },
        { new: true }
      )
      if (parcel) {
        return res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=success&tracking=${parcel.trackingId}`)
      }
    }
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=invalid`)
  } catch (err) {
    console.error('Payment success handler error:', err)
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=error`)
  }
}

// POST /api/payment/fail
export const paymentFail = async (req, res) => {
  try {
    await Parcel.findOneAndUpdate({ transactionId: req.body.tran_id }, { paymentStatus: 'failed' })
  } catch (err) {
    console.error('Payment fail handler error:', err)
  }
  res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=failed`)
}

// POST /api/payment/cancel
export const paymentCancel = async (req, res) => {
  try {
    await Parcel.findOneAndUpdate({ transactionId: req.body.tran_id }, { paymentStatus: 'cancelled' })
  } catch (err) {
    console.error('Payment cancel handler error:', err)
  }
  res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=cancelled`)
}

// POST /api/payment/ipn — server-to-server, source of truth, no redirect
export const paymentIPN = async (req, res) => {
  try {
    const { tran_id, val_id, status } = req.body
    if (status === 'VALID') {
      const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live)
      const validation = await sslcz.validate({ val_id })
      if (validation.status === 'VALID' || validation.status === 'VALIDATED') {
        await Parcel.findOneAndUpdate(
          { transactionId: tran_id },
          {
            paymentStatus: 'paid',
            sslTransactionId: val_id,
            paidAmount: validation.amount,
            paidAt: new Date(),
          }
        )
      }
    }
    res.status(200).send('IPN received')
  } catch (err) {
    console.error('IPN handler error:', err)
    res.status(500).send('IPN processing failed')
  }
}