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

export const env = {
  get port() {
    return Number(process.env.PORT) || 5000
  },
  get frontendUrl() {
    return normalizeBaseUrl(requireEnv('FRONTEND_URL'))
  },
  get allowedFrontendOrigin() {
    return process.env.CLIENT_URL?.trim() || requireEnv('FRONTEND_URL')
  },
}
