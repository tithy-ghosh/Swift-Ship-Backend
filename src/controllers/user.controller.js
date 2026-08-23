import User from '../models/user.model.js'

/**
 * POST /api/users
 * Ensures the verified Firebase account has a MongoDB profile.
 */
export const createUser = async (req, res) => {
  const { name, phone, photoURL, provider } = req.body
  const { uid, email, name: tokenName, picture } = req.user

  if (!uid || !email) {
    return res.status(400).json({ error: 'The authenticated account must have a uid and email' })
  }

  const safeName = String(name || tokenName || email.split('@')[0]).trim().slice(0, 100)
  const profileUpdates = {
    name: safeName,
    email: email.toLowerCase(),
    lastLoginAt: new Date(),
  }

  if (typeof phone === 'string' && phone.trim()) {
    profileUpdates.phone = phone.trim().slice(0, 30)
  }
  
  const safePhotoURL = photoURL || picture
  const initialPhotoURL = typeof safePhotoURL === 'string' && safePhotoURL.trim()
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

/** PUT /api/users/me */
export const updateProfile = async (req, res) => {
  const { name, phone, photoURL, address } = req.body;
  const { uid } = req.user;
  const profileUpdates = {}
  
  if(typeof name === 'string' && name.trim()){
    profileUpdates.name = name.trim().slice(0, 100)
  }
  if(typeof phone === 'string' && phone.trim()){
    profileUpdates.phone = phone.trim().slice(0, 30)
  }
  if(typeof photoURL === 'string' && photoURL.trim()){
    profileUpdates.photoURL = photoURL.trim().slice(0, 2048)
  }
  if (typeof address === 'string' && address.trim()) {
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


// ✅ ADMIN-ONLY FUNCTIONS 


/**
 * GET /api/users
 * Admin only: get all users sorted by newest first
 */
export const getAllUsers = async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    return res.status(200).json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
}

/**
 * DELETE /api/users/:id
 * Admin only: Delete a user by their MongoDB _id
 */
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const adminUid = req.user.uid;

    // 1. Fetch the user first to check their role and uid
    const userToDelete = await User.findById(id);
    if (!userToDelete) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 2. RULE: Prevent deleting an admin account (to avoid locking out the system)
    if (userToDelete.role === 'admin') {
      return res.status(403).json({ error: 'Cannot delete an admin account. Please change their role to customer first.' });
    }

    // 3. RULE: Prevent an admin from deleting themselves
    if (userToDelete.uid === adminUid) {
      return res.status(403).json({ error: 'You cannot delete your own account.' });
    }

    // 4. Proceed with deletion
    await User.findByIdAndDelete(id);
    return res.status(200).json({ message: 'User deleted successfully' });
    
  } catch (error) {
    console.error('Error deleting user:', error);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
}

/**
 * PUT /api/users/:id/role
 * Admin only: Update a user's role
 */
export const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const adminUid = req.user.uid; // The UID of the admin making the request

    const validRoles = ['customer', 'rider', 'admin'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // 1. Fetch the user first to apply safety rules
    const userToUpdate = await User.findById(id);
    if (!userToUpdate) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 2. RULE: Prevent self-demotion
    if (userToUpdate.uid === adminUid) {
      return res.status(403).json({ error: 'You cannot change your own role. Ask another admin to do it.' });
    }

    // 3. RULE: Prevent demoting the last admin in the system
    if (userToUpdate.role === 'admin' && role !== 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return res.status(403).json({ error: 'Cannot demote the last admin in the system.' });
      }
    }

    // 4. Update the role
    userToUpdate.role = role;
    await userToUpdate.save();

    return res.status(200).json({ 
      message: 'User role updated successfully',
      user: userToUpdate 
    });
  } catch (error) {
    console.error('Error updating user role:', error);
    return res.status(500).json({ error: 'Failed to update user role' });
  }
}