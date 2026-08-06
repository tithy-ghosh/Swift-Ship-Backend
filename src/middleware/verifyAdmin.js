import asyncHandler from './asyncHandler.js';

export const verifyAdmin = asyncHandler(async (req, res, next) => {
  // req.user is set by verifyToken middleware
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized: No user found' });
  }

// Check if user has admin role
 // The user need to be fetched from DB to get the role.
  const User = ( await import('../models/user.model.js')).default;
  const user = await User.findOne({ uid: req.user.uid });
  if(!user) {
    return res.status(404).json({
      error: 'User not found',
    })
  }

  if(user.role !== 'admin'){
    return res.status(403).json({
      error: 'Forbidden: Admin access required'
    })
  }

  // User is admin, proceed

  req.adminUser = user;
  next();
})