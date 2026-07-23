/**
 * Creates a human-readable tracking identifier.
 *
 * MongoDB's unique index remains the final collision safeguard.
 *
 * @returns {string}
 */
export const generateTrackingId = () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `SS-${date}-${randomPart}`
}
