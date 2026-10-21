import ActivityLog from '../models/activityLog.model.js';

/**
 * Appends one entry to the admin activity log so the audit trail has a
 * record of every administrative change.
 *
 * Every caller knows who acted (`actorUid` / `actorName` come from the
 * verified token) and what changed, so the shape stays boring on purpose:
 * the activity-log screen renders whatever fields are present.
 *
 * It is fire-and-forget: the action itself has already succeeded by the time
 * this runs, and a failure to write the audit entry must never turn a
 * completed action into an error response for the admin.
 *
 * @param {{actorUid: string, actorName: string, action: string,
 *          targetType?: string, targetId?: string, targetName?: string,
 *          details?: object}} entry
 */
export const logAdminAction = async ({
  actorUid,
  actorName,
  action,
  targetType,
  targetId,
  targetName,
  details,
}) => {
  try {
    await ActivityLog.create({
      actorUid,
      actorName,
      action,
      targetType,
      targetId,
      targetName: targetName || '',
      details: details || {},
    });
  } catch {
    // The parent action has already succeeded, so an audit-log failure must
    // not break the admin's flow.
  }
};
