import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import connectDB from './config/db.js'
import userRoutes from './routes/user.routes.js'
import parcelRoutes from './routes/parcel.routes.js'
import paymentRoutes from './routes/payment.routes.js'
const app = express()
const PORT = process.env.PORT || 5000

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL }))
app.use(express.json())
// SSLCommerz posts its success/fail/cancel/ipn callbacks as application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }))

// Routes
app.use('/api/users', userRoutes)
app.use('/api/parcels', parcelRoutes)
app.use('/api/payment', paymentRoutes)

// Health check
app.get('/', (req, res) => {
  res.json({ message: 'Swift Ship server is running' })
})

// Start
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
})