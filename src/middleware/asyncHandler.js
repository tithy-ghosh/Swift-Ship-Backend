/**
 * Adapts an async Express handler so rejected promises reach the centralized
 * error middleware.
 *
 * @param {import('express').RequestHandler} handler
 * @returns {import('express').RequestHandler}
 */
const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next)
}

export default asyncHandler
