import Setting from '../models/setting.model.js'

const DOCUMENT_TYPE = 'document'

/**
 * Fallback values used only if no Setting document exists yet (e.g. a fresh
 * database). Once an admin saves settings, the DB values always win.
 */
export const DEFAULT_PRICING = {
  documentWithinCityRate: 50,
  documentOutsideCityRate: 80,
  nonDocumentBaseWithinCityRate: 80,
  nonDocumentBaseOutsideCityRate: 130,
  maxBaseWeightKg: 3,
  extraWeightRatePerKg: 20,
  outsideCityExtraCharge: 20,
  minimumCharge: 40,
}

// Short-lived in-memory cache so every quote/parcel request doesn't hit Mongo.
// Invalidated immediately whenever an admin saves pricing settings.
let cachedPricing = null
let cachedAt = 0
const CACHE_TTL_MS = 30_000

/**
 * Resolves the pricing configuration currently in effect, merging saved
 * overrides on top of the defaults above.
 */
export const getActivePricing = async () => {
  const isCacheFresh = cachedPricing && Date.now() - cachedAt < CACHE_TTL_MS
  if (isCacheFresh) return cachedPricing

  const settingsDoc = await Setting.findOne().select('pricing').lean()
  cachedPricing = { ...DEFAULT_PRICING, ...(settingsDoc?.pricing || {}) }
  cachedAt = Date.now()

  return cachedPricing
}

/** Call after any write to Setting.pricing so the next quote uses fresh values. */
export const invalidatePricingCache = () => {
  cachedPricing = null
}

/**
 * Calculates the authoritative delivery charge for a parcel.
 *
 * Pricing is intentionally kept on the server. Values submitted by the client
 * must never be trusted when a parcel is persisted.
 *
 * @param {{
 *   type: 'document'|'non-document',
 *   weight?: number|string,
 *   senderServiceCenter: string,
 *   receiverServiceCenter: string
 * }} input
 * @returns {Promise<{
 *   deliveryCost: number,
 *   deliveryZone: string,
 *   costBreakdown: Array<{label: string, amount: number}>
 * }>}
 */
export const calculateDeliveryCharge = async ({
  type,
  weight,
  senderServiceCenter,
  receiverServiceCenter,
}) => {
  const pricing = await getActivePricing()

  const parcelWeight = Math.max(Number(weight) || 1, 1)
  const isWithinCity = senderServiceCenter === receiverServiceCenter
  const deliveryZone = isWithinCity ? 'Within City' : 'Outside City/District'

  if (type === DOCUMENT_TYPE) {
    const rate = isWithinCity ? pricing.documentWithinCityRate : pricing.documentOutsideCityRate
    const deliveryCost = Math.max(rate, pricing.minimumCharge)
    return {
      deliveryCost,
      deliveryZone,
      costBreakdown: [{ label: `Document delivery (${deliveryZone})`, amount: deliveryCost }],
    }
  }

  const baseCost = isWithinCity
    ? pricing.nonDocumentBaseWithinCityRate
    : pricing.nonDocumentBaseOutsideCityRate

  if (parcelWeight <= pricing.maxBaseWeightKg) {
    const deliveryCost = Math.max(baseCost, pricing.minimumCharge)
    return {
      deliveryCost,
      deliveryZone,
      costBreakdown: [
        {
          label: `Non-document base charge up to ${pricing.maxBaseWeightKg} kg (${deliveryZone})`,
          amount: baseCost,
        },
      ],
    }
  }

  const extraWeight = Math.ceil(parcelWeight - pricing.maxBaseWeightKg)
  const extraWeightCost = extraWeight * pricing.extraWeightRatePerKg
  const outsideCityCharge = isWithinCity ? 0 : pricing.outsideCityExtraCharge
  const deliveryCost = Math.max(baseCost + extraWeightCost + outsideCityCharge, pricing.minimumCharge)

  const costBreakdown = [
    {
      label: `Non-document base charge up to ${pricing.maxBaseWeightKg} kg (${deliveryZone})`,
      amount: baseCost,
    },
    {
      label: `Extra weight charge (${extraWeight} kg x BDT ${pricing.extraWeightRatePerKg})`,
      amount: extraWeightCost,
    },
  ]

  if (outsideCityCharge) {
    costBreakdown.push({ label: 'Outside city/district charge', amount: outsideCityCharge })
  }

  return { deliveryCost, deliveryZone, costBreakdown }
}