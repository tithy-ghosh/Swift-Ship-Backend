/**
 * Merchant returns: reverse pickups (customer -> merchant).
 *
 * Validation and document building are pure, like `pickup.service.js`: the
 * controller resolves ownership, eligibility and the drop-off address from the
 * database and hands those facts here, so the interesting rules run under the
 * unit tests without a database.
 */

export const MAX_RETURN_REASON_LENGTH = 300
export const MAX_RETURN_NOTE_LENGTH = 300
const MAX_PICKUP_ADDRESS_LENGTH = 200

/**
 * Whether an original parcel may be returned right now, from the three facts
 * the database knows: the newest tracking status, the parcel's own direction
 * (a return cannot be returned again) and whether an active return already
 * exists for it (a cancelled one does not count - the merchant may retry).
 *
 * @param {{status?: string, direction?: string, hasActiveReturn?: boolean}} facts
 * @returns {{ok: boolean, error: string}}
 */
export const returnEligibility = ({ status, direction, hasActiveReturn } = {}) => {
  if (direction === 'return') {
    return { ok: false, error: 'This parcel is already a return shipment.' }
  }
  if (status !== 'delivered') {
    return { ok: false, error: 'Only a delivered parcel can be returned.' }
  }
  if (hasActiveReturn) {
    return { ok: false, error: 'A return for this parcel is already in progress.' }
  }

  return { ok: true, error: '' }
}

/**
 * Builds the new return parcel from the original plus the merchant's form.
 *
 * Sender is the original receiver (that is where the rider collects), receiver
 * is the merchant's resolved pickup address. The pickup address text defaults
 * to the original receiver's address but the merchant may correct it - the
 * customer may have moved. Type, weight and title are inherited: the same
 * goods are travelling back. The delivery charge comes in as `pricing`,
 * already quoted through the shared pricing service.
 *
 * @param {{
 *   original: object,
 *   merchant: {businessName: string, phone?: string},
 *   dropAddress: {region: string, district: string, address: string, contactPhone?: string},
 *   payload?: {reason?: string, pickupAddress?: string, note?: string},
 *   pricing: {deliveryCost: number, deliveryZone: string, costBreakdown: Array},
 * }} input
 * @returns {{errors: string[], parcel: object|null}} `parcel` is only
 *   meaningful when `errors` is empty.
 */
export const buildReturnParcel = ({
  original,
  merchant,
  dropAddress,
  payload = {},
  pricing,
}) => {
  const errors = []
  const reason = String(payload.reason || '').trim()
  const note = String(payload.note || '').trim()
  const pickupAddress =
    String(payload.pickupAddress || '').trim() || String(original.receiverAddress || '').trim()

  if (!reason) {
    errors.push('A reason for the return is required.')
  } else if (reason.length > MAX_RETURN_REASON_LENGTH) {
    errors.push(`Return reason is too long (max ${MAX_RETURN_REASON_LENGTH} characters).`)
  }

  if (!pickupAddress) {
    errors.push('A pickup address for the return is required.')
  } else if (pickupAddress.length > MAX_PICKUP_ADDRESS_LENGTH) {
    errors.push(`Pickup address is too long (max ${MAX_PICKUP_ADDRESS_LENGTH} characters).`)
  }

  if (note.length > MAX_RETURN_NOTE_LENGTH) {
    errors.push(`Note is too long (max ${MAX_RETURN_NOTE_LENGTH} characters).`)
  }

  if (errors.length) return { errors, parcel: null }

  // Same routing rule as a forward booking: a cross-district return starts on
  // the pickup leg (rider collects and parks it at the sending godown).
  const crossDistrict = original.receiverServiceCenter !== dropAddress.district

  return {
    errors: [],
    parcel: {
      type: original.type,
      title: original.title || '',
      weight: original.weight || 0,
      senderName: original.receiverName,
      senderContact: original.receiverContact,
      senderRegion: original.receiverRegion,
      senderServiceCenter: original.receiverServiceCenter,
      senderAddress: pickupAddress,
      pickupInstruction: note,
      receiverName: merchant.businessName,
      receiverContact: dropAddress.contactPhone || merchant.phone || '',
      receiverRegion: dropAddress.region,
      receiverServiceCenter: dropAddress.district,
      receiverAddress: dropAddress.address,
      leg: crossDistrict ? 'pickup' : null,
      direction: 'return',
      returnOf: {
        trackingId: original.trackingId,
        parcelId: original._id,
        reason,
      },
      ...pricing,
    },
  }
}
