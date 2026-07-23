const DOCUMENT_TYPE = 'document'
const EXTRA_WEIGHT_RATE = 20
const MAX_BASE_WEIGHT_KG = 3

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
 * @returns {{
 *   deliveryCost: number,
 *   deliveryZone: string,
 *   costBreakdown: Array<{label: string, amount: number}>
 * }}
 */
export const calculateDeliveryCharge = ({
  type,
  weight,
  senderServiceCenter,
  receiverServiceCenter,
}) => {
  const parcelWeight = Math.max(Number(weight) || 1, 1)
  const isWithinCity = senderServiceCenter === receiverServiceCenter
  const deliveryZone = isWithinCity ? 'Within City' : 'Outside City/District'

  if (type === DOCUMENT_TYPE) {
    const deliveryCost = isWithinCity ? 50 : 80
    return {
      deliveryCost,
      deliveryZone,
      costBreakdown: [{ label: `Document delivery (${deliveryZone})`, amount: deliveryCost }],
    }
  }

  const baseCost = isWithinCity ? 80 : 130

  if (parcelWeight <= MAX_BASE_WEIGHT_KG) {
    return {
      deliveryCost: baseCost,
      deliveryZone,
      costBreakdown: [
        { label: `Non-document base charge up to 3 kg (${deliveryZone})`, amount: baseCost },
      ],
    }
  }

  const extraWeight = Math.ceil(parcelWeight - MAX_BASE_WEIGHT_KG)
  const extraWeightCost = extraWeight * EXTRA_WEIGHT_RATE
  const outsideCityCharge = isWithinCity ? 0 : 20
  const deliveryCost = baseCost + extraWeightCost + outsideCityCharge
  const costBreakdown = [
    { label: `Non-document base charge up to 3 kg (${deliveryZone})`, amount: baseCost },
    { label: `Extra weight charge (${extraWeight} kg x BDT 20)`, amount: extraWeightCost },
  ]

  if (outsideCityCharge) {
    costBreakdown.push({ label: 'Outside city/district charge', amount: outsideCityCharge })
  }

  return { deliveryCost, deliveryZone, costBreakdown }
}
