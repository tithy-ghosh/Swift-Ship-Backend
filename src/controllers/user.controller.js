import User from '../models/user.model.js'

/**
 * POST /api/users
 *
 * Creates the MongoDB profile associated with a verified Firebase account.
 * Repeated calls are idempotent and return the existing profile.
 */
export const createUser = async (req, res) => {
  const { name, phone } = req.body
  const { uid, email } = req.user

  if (!name || !email) {
    return res.status(400).json({ error: 'name and authenticated email are required' })
  }

  const existingUser = await User.findOne({ uid })
  if (existingUser) {
    return res.status(200).json(existingUser)
  }

  const user = await User.create({
    uid,
    name,
    email,
    phone: phone || '',
    role: 'customer',
  })

  return res.status(201).json(user)
}

/** GET /api/users/me */
export const getCurrentUser = async (req, res) => {
  const user = await User.findOne({ uid: req.user.uid })

  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  return res.json(user)
}
