import 'dotenv/config'

/**
 * Returns a required environment variable.
 *
 * Validation happens when a feature uses its configuration rather than during
 * application startup. This allows unrelated endpoints (such as health checks)
 * to remain available when an optional integration is not configured.
 *
 * @param {string} name Environment variable name.
 * @returns {string} Trimmed environment variable value.
 * @throws {Error} When the variable is missing or empty.
 */
export const requireEnv = (name) => {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

/**
 * Removes a trailing slash so route paths can be appended consistently.
 *
 * @param {string} url
 * @returns {string}
 */
export const normalizeBaseUrl = (url) => url.replace(/\/+$/, '')

/**
 * Splits a comma-separated list of origins, trims each entry, strips trailing
 * slashes, and drops empty values.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
const parseOrigins = (value) =>
  (value || '')
    .split(',')
    .map((origin) => normalizeBaseUrl(origin.trim()))
    .filter(Boolean)

export const env = {
  get port() {
    return Number(process.env.PORT) || 5000
  },
  // Primary frontend URL, used for payment redirects.
  get frontendUrl() {
    return normalizeBaseUrl(requireEnv('FRONTEND_URL'))
  },
  // Every origin allowed by CORS: FRONTEND_URL plus any extra origins listed
  // (comma-separated) in the optional CLIENT_URL.
  get allowedFrontendOrigins() {
    return [
      ...new Set([
        normalizeBaseUrl(requireEnv('FRONTEND_URL')),
        ...parseOrigins(process.env.CLIENT_URL),
      ]),
    ]
  },
}