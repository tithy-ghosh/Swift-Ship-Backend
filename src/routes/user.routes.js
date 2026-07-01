import express from 'express'
import User from '../models/user.model.js'
import verifyToken from '../middleware/verifyToken.js'

const router = express.Router()

// POST /api/users
// Called right after Firebase signup to save user in MongoDB
router.post('/', verifyToken, async (req, res) => {
  try {
    const { name, email, phone } = req.body
    const uid = req.user.uid

    // Check if user already exists (e.g. Google login on second visit)
    const existingUser = await User.findOne({ uid })
    if (existingUser) {
      return res.status(200).json(existingUser)
    }

    const newUser = await User.create({
      uid,
      name,
      email,
      phone: phone || '',
      role: 'customer',
    })

    res.status(201).json(newUser)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/users/me
// Get the logged-in user's profile
router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.user.uid })
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json(user)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

export default router