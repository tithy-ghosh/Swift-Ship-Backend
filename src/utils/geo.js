const EARTH_RADIUS_KM = 6371

const toRadians = (degrees) => (degrees * Math.PI) / 180

/**
 * Great-circle distance between two coordinates, in kilometres.
 *
 * Haversine rather than the law of cosines: the law of cosines loses
 * precision at short distances because it subtracts two numbers close to 1,
 * and a rider's two nearest service centres can be under a kilometre apart.
 *
 * @param {{latitude: number, longitude: number}} from
 * @param {{latitude: number, longitude: number}} to
 * @returns {number} Distance in km, rounded to 2 decimals.
 */
export const haversineKm = (from, to) => {
  if (!from || !to) return 0

  const lat1 = Number(from.latitude)
  const lng1 = Number(from.longitude)
  const lat2 = Number(to.latitude)
  const lng2 = Number(to.longitude)

  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return 0

  const deltaLat = toRadians(lat2 - lat1)
  const deltaLng = toRadians(lng2 - lng1)

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLng / 2) ** 2

  // `min(1, ...)` guards against a >1 result from floating point drift on
  // antipodal points, which would make `asin` return NaN.
  const distance = 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, a)))

  return Math.round(distance * 100) / 100
}
