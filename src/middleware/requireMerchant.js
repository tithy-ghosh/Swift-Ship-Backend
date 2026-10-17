import User from '../models/user.model.js'
import MerchantApplication from '../models/merchantApplication.model.js'

/**
 * Guards the merchant workspace.
 *
 * Mirrors `requireRider`: it checks both the account role and the *approved*
 * application. `User.role` alone is not enough because an admin can flip a
 * role directly via `PUT /api/users/:id/role`, which would otherwise hand the
 * merchant workspace to someone with no business record, no pickup address,
 * and nothing to ship.
 *
 * Sets `req.merchant` to the approved application - the operational record.
 *
 * Must run after `verifyToken`, which is what populates `req.user`.
 */
const requireMerchant = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized: No user found' })
  }

  const user = await User.findOne({ uid: req.user.uid }).select('name role')
  if (!user || user.role !== 'merchant') {
    return res.status(403).json({ error: 'Merchant access required' })
  }

  const merchant = await MerchantApplication.findOne({
    userId: req.user.uid,
    status: 'approved',
  })
  if (!merchant) {
    return res.status(403).json({
      error: 'No approved merchant profile found. Contact support if this looks wrong.',
    })
  }

  req.merchant = merchant
  req.merchantUser = user
  return next()
}

export default requireMerchant
