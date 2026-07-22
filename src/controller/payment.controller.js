const SSLCommerzPayment = require('sslcommerz-lts');
const Parcel = require('../models/Parcel');

const store_id = process.env.SSLCZ_STORE_ID;
const store_passwd = process.env.SSLCZ_STORE_PASSWORD;
const is_live = false; 

// Initialize payment
exports.initPayment = async (req, res) => {
  try {
    const parcel = await Parcel.findById(req.params.parcelId).populate('sender receiver');
    if (!parcel) return res.status(404).json({ error: 'Parcel not found' });

    const tran_id = `SWFT-${parcel._id}-${Date.now()}`;
    parcel.transactionId = tran_id;
    parcel.paymentMethod = 'online';
    await parcel.save();

    const data = {
      total_amount: parcel.deliveryFee,
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
      cus_name: parcel.sender.name,
      cus_email: parcel.sender.email,
      cus_add1: parcel.pickupAddress,
      cus_phone: parcel.sender.phone,
      cus_city: parcel.pickupCity || 'Dhaka',
      cus_country: 'Bangladesh',
      ship_name: parcel.receiver.name,
      ship_add1: parcel.deliveryAddress,
      ship_city: parcel.deliveryCity || 'Dhaka',
      ship_country: 'Bangladesh',
    };

    const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
    const apiResponse = await sslcz.init(data);
    res.json({ gatewayUrl: apiResponse.GatewayPageURL });
  } catch (err) {
    console.error('SSLCommerz init error:', err);
    res.status(500).json({ error: 'Payment initialization failed' });
  }
};

// Set payment method (called when user picks COD instead of online)
exports.setPaymentMethod = async (req, res) => {
  try {
    const { paymentMethod } = req.body;
    const parcel = await Parcel.findById(req.params.parcelId);
    if (!parcel) return res.status(404).json({ error: 'Parcel not found' });

    parcel.paymentMethod = paymentMethod;
    if (paymentMethod === 'cod') {
      parcel.paymentStatus = 'pending'; // cleared later by delivery agent
    }
    await parcel.save();
    res.json({ success: true, parcel });
  } catch (err) {
    console.error('Set payment method error:', err);
    res.status(500).json({ error: 'Failed to set payment method' });
  }
};

// Success callback
exports.paymentSuccess = async (req, res) => {
  try {
    const { tran_id, val_id } = req.body;
    const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
    const validation = await sslcz.validate({ val_id });

    if (validation.status === 'VALID' || validation.status === 'VALIDATED') {
      const parcel = await Parcel.findOne({ transactionId: tran_id });
      if (parcel) {
        parcel.paymentStatus = 'paid';
        parcel.sslTransactionId = val_id;
        parcel.paidAmount = validation.amount;
        parcel.paidAt = new Date();
        await parcel.save();
        return res.redirect(`${process.env.FRONTEND_URL}/parcels/${parcel._id}?payment=success`);
      }
    }
    return res.redirect(`${process.env.FRONTEND_URL}/parcels?payment=invalid`);
  } catch (err) {
    console.error('Payment success handler error:', err);
    res.redirect(`${process.env.FRONTEND_URL}/parcels?payment=error`);
  }
};

// Fail callback
exports.paymentFail = async (req, res) => {
  try {
    await Parcel.findOneAndUpdate({ transactionId: req.body.tran_id }, { paymentStatus: 'failed' });
  } catch (err) {
    console.error('Payment fail handler error:', err);
  }
  res.redirect(`${process.env.FRONTEND_URL}/parcels?payment=failed`);
};

// Cancel callback
exports.paymentCancel = async (req, res) => {
  try {
    await Parcel.findOneAndUpdate({ transactionId: req.body.tran_id }, { paymentStatus: 'cancelled' });
  } catch (err) {
    console.error('Payment cancel handler error:', err);
  }
  res.redirect(`${process.env.FRONTEND_URL}/parcels?payment=cancelled`);
};

// IPN listener (source of truth)
exports.paymentIPN = async (req, res) => {
  try {
    const { tran_id, val_id, status } = req.body;
    if (status === 'VALID') {
      const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
      const validation = await sslcz.validate({ val_id });
      if (validation.status === 'VALID' || validation.status === 'VALIDATED') {
        await Parcel.findOneAndUpdate(
          { transactionId: tran_id },
          {
            paymentStatus: 'paid',
            sslTransactionId: val_id,
            paidAmount: validation.amount,
            paidAt: new Date(),
          }
        );
      }
    }
    res.status(200).send('IPN received');
  } catch (err) {
    console.error('IPN handler error:', err);
    res.status(500).send('IPN processing failed');
  }
};