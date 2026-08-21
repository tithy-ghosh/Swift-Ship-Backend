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
  // A provider picture is an initial fallback only. Updating it on every
  // login would overwrite a profile image the user uploaded later.
  const safePhotoURL = photoURL || picture
  const initialPhotoURL =
    typeof safePhotoURL === 'string' && safePhotoURL.trim()
      ? safePhotoURL.trim().slice(0, 2048)
      : undefined
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
        ...(initialPhotoURL ? { photoURL: initialPhotoURL } : {}),
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

/** PUT/api/users/me */

export const updateProfile = async (req, res) => {
  const { name, phone, photoURL, address } = req.body;
  const { uid } = req.user;
  const profileUpdates = {}
  if(typeof name === 'string' && name.trim()){
    profileUpdates.name = name.trim().slice(0, 100)
  }
  if(typeof phone === 'string'){
    profileUpdates.phone = phone.trim().slice(0, 30)
  }
  if(typeof photoURL === 'string'){
    profileUpdates.photoURL = photoURL.trim().slice(0, 2048)
  }
  if (typeof address === 'string') {
    profileUpdates.address = address.trim().slice(0, 500)
  }
   const user = await User.findOneAndUpdate(
    { uid },
    { $set: profileUpdates },
    { new: true, runValidators: true }
  )

  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }
   return res.status(200).json(user)
}
 // Admin Only:

/**
 * GET /api/users
 * Admin only: get all users sorted by newest first
 */

export const getAllUsers = async(req, res) => {
  try{
    const users = await User.find().sort({ createdAt: -1 });
    return res.status(200).json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
}
/**
   * DELETE/api/users
   * Admin only: Delete a user by their MongoDB_id
   */
  export const deleteUser = async(req, res) => {
    try {
      const { id } = req.params;

      if(req.user.uid === req.params.uid){
       
      }
      const user = await User.findByIdAndDelete(id);
      if(!user){
        return res.status(404).json({ message: 'User not found' });
      }
      return res.status(200).json({ message: 'User deleted successfully'});
    } catch (error) {
       console.error('Error deleting user:', error);
    return res.status(500).json({ error: 'Failed to delete user' });
    }
  }
