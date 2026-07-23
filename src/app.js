import cors from 'cors'
import express from 'express'
import { env } from './config/env.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import parcelRoutes from './routes/parcel.routes.js'
import paymentRoutes from './routes/payment.routes.js'
import userRoutes from './routes/user.routes.js'

/**
 * Creates the Express application without opening a network port.
 *
 * Keeping construction separate from startup makes the complete HTTP app
 * importable by integration tests without requiring a live server.
 *
 * @returns {import('express').Express}
 */
export const createApp = () => {
  const app = express()

  app.disable('x-powered-by')
  app.use(cors({ origin: env.allowedFrontendOrigin }))
  app.use(express.json({ limit: '100kb' }))

  // SSLCommerz sends browser callbacks and IPNs as form-encoded payloads.
  app.use(express.urlencoded({ extended: true, limit: '100kb' }))

  app.get('/', (req, res) => {
    res.json({ message: 'Swift Ship server is running' })
  })

  app.use('/api/users', userRoutes)
  app.use('/api/parcels', parcelRoutes)
  app.use('/api/payment', paymentRoutes)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}

export default createApp()
