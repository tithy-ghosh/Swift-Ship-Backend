import User from '../models/user.model.js'

const STAFF_ROLES = new Set(['admin', 'rider'])

const requireStaff = async (req, res, next) => {
  const user = await User.findOne({ uid: req.user.uid }).select('name role')

  if (!user || !STAFF_ROLES.has(user.role)) {
    return res.status(403).json({ error: 'Staff access required' })
  }

  req.staffUser = user
  return next()
}

export default requireStaff
