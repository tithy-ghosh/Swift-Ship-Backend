import Announcement from '../models/announcement.model.js'

/**
 * Announcement audience rules and reads.
 *
 * One place owns "who sees what": a role sees announcements targeted at that
 * role plus the `all` broadcast. `visibleTargetsFor` is exported so the rule
 * can be unit tested without a database - cross-audience leakage (a merchant
 * reading a riders-only message) is a privacy bug, not a display bug.
 */

/** Targets a role is allowed to see: its own plus the `all` broadcast. */
export const visibleTargetsFor = (role) => {
  const audience = { rider: 'rider', customer: 'customer', merchant: 'merchant' }[role]
  return audience ? [audience, 'all'] : ['all']
}

const serializeAnnouncement = (announcement) => ({
  id: String(announcement._id),
  title: announcement.title,
  body: announcement.body,
  target: announcement.target,
  createdAt: announcement.createdAt,
})

/**
 * Active, non-expired announcements visible to `role`, newest first.
 *
 * @param {'rider'|'customer'|'merchant'} role
 */
export const findActiveAnnouncementsFor = async (role) => {
  const now = new Date()

  const announcements = await Announcement.find({
    isActive: true,
    target: { $in: visibleTargetsFor(role) },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .sort({ createdAt: -1 })
    .lean()

  return announcements.map(serializeAnnouncement)
}
