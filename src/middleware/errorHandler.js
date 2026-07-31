/**
 * Handles requests that do not match a registered API route.
 */
export const notFoundHandler = (req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` })
}

/**
 * Final Express error boundary. Internal details are logged on the server but
 * are not exposed to clients.
 *
 * @type {import('express').ErrorRequestHandler}
 */
export const errorHandler = (error, req, res, next) => {
  if (res.headersSent) {
    return next(error)
  }

  console.error(`[${req.method} ${req.originalUrl}]`, error)

  const statusCode =
    error.name === 'MulterError'
      ? 400
      : Number.isInteger(error.statusCode)
        ? error.statusCode
        : 500
  const message =
    error.name === 'MulterError' && error.code === 'LIMIT_FILE_SIZE'
      ? 'Profile image must be 2 MB or smaller'
      : statusCode >= 500 && !error.expose ? 'Internal server error' : error.message

  return res.status(statusCode).json({ error: message })
}
