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
 * completed action into an error response for the admin. Failures are logged
 * with full context so they are visible in the server console instead of
 * being silently swallowed.
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
  } catch (error) {
    // Never silently swallow an audit-log failure: log it with full context
    // so it is visible in the server console. The parent action has already
    // succeeded, so we do not re-throw and break the admin's flow.
    console.error(
      'Failed to record activity log entry:',
      { action, targetType, targetId, error }
    );
  }
};
