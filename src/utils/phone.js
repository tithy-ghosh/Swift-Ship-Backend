/**
 * Bangladeshi mobile numbers, in one place.
 *
 * Hand-typed sources (bulk-upload spreadsheets, pickup contacts) contain
 * `+880`, `880`, spaces and dashes, so every feature that accepts a phone
 * number normalises through here and treats `''` as "not a valid number".
 */

/** Same pattern the booking form and profile editor enforce. */
export const BD_PHONE = /^01[3-9]\d{8}$/

/**
 * Normalises a Bangladeshi mobile number to `01XXXXXXXXX`.
 *
 * Accepts what spreadsheets realistically contain: `01712345678`,
 * `+8801712345678`, `8801712345678`, with spaces or dashes.
 *
 * @returns {string} the normalised number, or `''` when it is not valid
 */
export const normalizeBdPhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '')
  const local = digits.startsWith('8801') ? digits.slice(2) : digits
  return BD_PHONE.test(local) ? local : ''
}
