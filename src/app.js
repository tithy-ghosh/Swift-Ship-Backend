import cors from 'cors'
import express from 'express'
import { env } from './config/env.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import parcelRoutes from './routes/parcel.routes.js'
import paymentRoutes from './routes/payment.routes.js'
import trackingRoutes from './routes/tracking.routes.js'
import userRoutes from './routes/user.routes.js'
import uploadRoutes from './routes/upload.routes.js'
import riderApplicationRoutes from './routes/riderApplication.routes.js'
import riderRoutes from './routes/rider.routes.js'
import merchantApplicationRoutes from './routes/merchantApplication.routes.js'
import merchantRoutes from './routes/merchant.routes.js'
import adminRoutes from './routes/admin.routes.js'
import settingRoutes from './routes/setting.route.js'

export const createApp = () => {
  const app = express()

  app.disable('x-powered-by')
  
  // ✅ UPDATED CORS: Explicitly allow Authorization header
  app.use(cors({ 
    origin: env.allowedFrontendOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // The admin CSV export names its file in Content-Disposition; without this
    // the browser hides the header from JS and every download lands as
    // "download.csv" instead of e.g. "swift-ship-users-2026-10-17.csv".
    exposedHeaders: ['Content-Disposition'],
    credentials: true
  }))
  
  app.use(express.json({ limit: '100kb' }))
  app.use(express.urlencoded({ extended: true, limit: '100kb' }))

  app.get('/', (req, res) => {
    res.json({ message: 'Swift Ship server is running' })
  })

  app.use('/api/users', userRoutes)
  app.use('/api/parcels', parcelRoutes)
  app.use('/api/payment', paymentRoutes)
  app.use('/api/tracking', trackingRoutes)
  app.use('/api/upload', uploadRoutes)
  app.use('/api/rider-applications', riderApplicationRoutes)
  app.use('/api/rider', riderRoutes)
  app.use('/api/merchant-applications', merchantApplicationRoutes)
  app.use('/api/merchant', merchantRoutes)
  app.use('/api/admin', adminRoutes)
  app.use('/api/settings', settingRoutes);
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}

export default createApp()