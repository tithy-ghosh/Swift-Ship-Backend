import districts from '../data/districts.data.json' with { type: 'json' }
import { haversineKm } from './geo.js'

/**
 * District name lookup backed by a static coordinate table.
 *
 * `Parcel.senderServiceCenter` / `receiverServiceCenter` and
 * `RiderApplication.district` are both district names drawn from the same
 * warehouse list on the frontend, so matching on that name is what lets a rider
 * see the jobs in their own area without a geocoding API.
 *
 * SOURCE OF TRUTH: this table is a projection of the frontend's
 * `src/app/data/warehouse.data.json` (region, district, latitude, longitude).
 * It is duplicated rather than fetched so the server keeps no runtime
 * dependency on the frontend repo. If a district is added there, add it here.
 */

const byName = new Map(
  districts.map((entry) => [entry.district.trim().toLowerCase(), entry])
)

/** Normalises a user- or form-supplied name to the lookup key. */
const normalize = (value) => String(value || '').trim().toLowerCase()

/**
 * @param {string} districtName
 * @returns {{region: string, district: string, latitude: number, longitude: number}|null}
 */
export const findDistrict = (districtName) => byName.get(normalize(districtName)) || null

/**
 * Convenience wrapper for callers that only need coordinates.
 *
 * @param {string} districtName
 * @returns {{latitude: number, longitude: number}|null} `null` when the district
 *   is unknown, so callers can render "distance unavailable" instead of 0 km.
 */
export const districtCoords = (districtName) => {
  const entry = findDistrict(districtName)
  if (!entry) return null
  return { latitude: entry.latitude, longitude: entry.longitude }
}

/**
 * Distance in km between two districts.
 *
 * @returns {number|null} `null` if either district is unknown - a wrong
 *   distance is worse than no distance for an accept/decline decision.
 */
export const distanceBetweenDistricts = (fromDistrict, toDistrict) => {
  const from = districtCoords(fromDistrict)
  const to = districtCoords(toDistrict)
  if (!from || !to) return null
  return haversineKm(from, to)
}
