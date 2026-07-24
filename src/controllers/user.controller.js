import User from '../models/user.model.js'

/**
 * POST /api/users
 *
 * Ensures the verified Firebase account has a MongoDB profile.
 *
 * This endpoint is intentionally safe to call after every authentication.
 * Firebase identity fields come from the verified token, while role and
 * creation time are server-owned and only receive defaults on first insert.
 */
export const createUser = async (req, res) => {
  const { name, phone, photoURL, provider } = req.body
  const { uid, email, name: tokenName, picture } = req.user

  if (!uid || !email) {
    return res.status(400).json({ error: 'The authenticated account must have a uid and email' })
  }

  const safeName =
    String(name || tokenName || email.split('@')[0]).trim().slice(0, 100)
  const profileUpdates = {
    name: safeName,
    email: email.toLowerCase(),
    lastLoginAt: new Date(),
  }

  // Empty values from a provider must not erase details collected previously.
  if (typeof phone === 'string' && phone.trim()) {
    profileUpdates.phone = phone.trim().slice(0, 30)
  }
  const safePhotoURL = photoURL || picture
  if (typeof safePhotoURL === 'string' && safePhotoURL.trim()) {
    profileUpdates.photoURL = safePhotoURL.trim().slice(0, 2048)
  }
  if (typeof provider === 'string' && provider.trim()) {
    profileUpdates.provider = provider.trim().slice(0, 50)
  }

  const user = await User.findOneAndUpdate(
    { uid },
    {
      $set: profileUpdates,
      $setOnInsert: {
        uid,
        role: 'customer',
      },
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  )

  return res.status(200).json(user)
}

/** GET /api/users/me */
export const getCurrentUser = async (req, res) => {
  const user = await User.findOne({ uid: req.user.uid })

  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  return res.json(user)
}
