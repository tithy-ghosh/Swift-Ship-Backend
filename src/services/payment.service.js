import SSLCommerzPayment from 'sslcommerz-lts'
import { env, normalizeBaseUrl, requireEnv } from '../config/env.js'

const PAYMENT_STATUS_VALID = new Set(['VALID', 'VALIDATED'])
const DEFAULT_POSTCODE = '1000'

/**
 * SSLCommerz is deliberately locked to sandbox mode for this educational
 * project. Never derive this value from NODE_ENV: deploying the demo must not
 * enable real transactions.
 */
const IS_LIVE_PAYMENT = false

const getClient = () =>
  new SSLCommerzPayment(
    requireEnv('SSLCZ_STORE_ID'),
    requireEnv('SSLCZ_STORE_PASSWORD'),
    IS_LIVE_PAYMENT
  )

/**
 * Builds the payload required by SSLCommerz's session API.
 *
 * The current parcel form does not collect postcodes. SSLCommerz requires both
 * postcode fields, so the sandbox payload uses a deterministic placeholder.
 *
 * @param {import('../models/parcel.model.js').default} parcel
 * @param {{email?: string}} authenticatedUser
 * @param {string} transactionId
 * @param {string} callbackToken
 * @returns {object}
 */
const buildPaymentPayload = (parcel, authenticatedUser, transactionId, callbackToken) => {
  const backendUrl = normalizeBaseUrl(requireEnv('BACKEND_URL'))
  const callbackQuery = new URLSearchParams({ token: callbackToken }).toString()

  return {
    total_amount: parcel.deliveryCost,
    currency: 'BDT',
    tran_id: transactionId,
    success_url: `${backendUrl}/api/payment/success?${callbackQuery}`,
    fail_url: `${backendUrl}/api/payment/fail?${callbackQuery}`,
    cancel_url: `${backendUrl}/api/payment/cancel?${callbackQuery}`,
    ipn_url: `${backendUrl}/api/payment/ipn?${callbackQuery}`,
    shipping_method: 'Courier',
    product_name: 'Parcel Delivery',
    product_category: 'Delivery',
    product_profile: 'general',
    cus_name: parcel.senderName,
    cus_email: authenticatedUser.email || 'no-reply@swiftship.app',
    cus_add1: parcel.senderAddress || parcel.senderServiceCenter,
    cus_phone: parcel.senderContact,
    cus_city: parcel.senderServiceCenter,
    cus_postcode: DEFAULT_POSTCODE,
    cus_country: 'Bangladesh',
    ship_name: parcel.receiverName,
    ship_add1: parcel.receiverAddress || parcel.receiverServiceCenter,
    ship_city: parcel.receiverServiceCenter,
    ship_postcode: DEFAULT_POSTCODE,
    ship_country: 'Bangladesh',
  }
}

/**
 * Opens a new SSLCommerz sandbox checkout session.
 *
 * @returns {Promise<string>} Gateway checkout URL.
 */
export const createPaymentSession = async (
  parcel,
  authenticatedUser,
  transactionId,
  callbackToken
) => {
  const response = await getClient().init(
    buildPaymentPayload(parcel, authenticatedUser, transactionId, callbackToken)
  )

  if (response?.status !== 'SUCCESS' || !response?.GatewayPageURL) {
    const error = new Error(
      response?.failedreason || 'Payment gateway did not return a checkout URL'
    )
    error.statusCode = 502
    error.expose = true
    throw error
  }

  return response.GatewayPageURL
}

/**
 * Validates a payment callback directly with SSLCommerz.
 *
 * @param {string} validationId SSLCommerz val_id.
 * @returns {Promise<object|null>} Valid response, or null for an invalid payment.
 */
export const validatePayment = async (validationId) => {
  const validation = await getClient().validate({ val_id: validationId })
  return PAYMENT_STATUS_VALID.has(validation?.status) ? validation : null
}

export const getPaymentRedirectUrl = (query) => {
  const searchParams = new URLSearchParams(query)
  return `${env.frontendUrl}/dashboard?${searchParams.toString()}`
}
