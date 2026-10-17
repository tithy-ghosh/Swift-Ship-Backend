import User from '../models/user.model.js'
import RiderApplication from '../models/riderApplication.model.js'

/**
 * Guards the rider app.
 *
 * Stricter than `requireStaff` in one specific way: it also requires an
 * *approved* application. `User.role` is demoted to 'customer' on
 * deactivation, but an admin can also flip role directly via
 * `PUT /api/users/:id/role`, which would otherwise hand the rider app to
 * someone with no rider record, no district, and nothing to deliver.
 *
 * Sets `req.rider` to the approved application - the operational record.
 *
 * Must run after `verifyToken`, which is what populates `req.user`.
 */
const requireRider = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized: No user found' })
  }

  const user = await User.findOne({ uid: req.user.uid }).select('name role')
  if (!user || user.role !== 'rider') {
    return res.status(403).json({ error: 'Rider access required' })
  }

  const rider = await RiderApplication.findOne({ userId: req.user.uid, status: 'approved' })
  if (!rider) {
    return res.status(403).json({
      error: 'No approved rider profile found. Contact support if this looks wrong.',
    })
  }

  req.rider = rider
  req.riderUser = user
  return next()
}

export default requireRider
