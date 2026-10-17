import RiderApplication from '../models/riderApplication.model.js';
import asyncHandler from '../middleware/asyncHandler.js';
import User from '../models/user.model.js';
import { logAdminAction } from '../services/activity-log.service.js';
// POST /api/rider-applications
export const submitRiderApplication = asyncHandler(async (req, res) => {
  const { uid } = req.user; // From verifyToken middleware
  const applicationData = req.body;

  // Prevent duplicate pending applications
  const existing = await RiderApplication.findOne({ 
    userId: uid, 
    status: { $in: ['pending', 'approved'] } 
  });

  if (existing) {
    return res.status(400).json({ 
      error: 'You already have an active rider application.' 
    });
  }

  const newApplication = await RiderApplication.create({
    userId: uid,
    ...applicationData,
    status: 'pending' // Enforce pending status on creation
  });

  res.status(201).json(newApplication);
});

//  GET /api/rider-applications (Admin only - Get all applications)
export const getAllRiderApplications = asyncHandler(async (req, res) => {
  const { status } = req.query; 
  
  const query = status ? { status } : {};
  const applications = await RiderApplication.find(query)
    .populate('userId', 'name email phone')
    .sort({ createdAt: -1 });
    res.status(200).json(applications);
})
// PUT /api/rider-applications/:id/approve (Admin only)
export const approveRiderApplication = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const application = await RiderApplication.findByIdAndUpdate(
    id,
    { 
      status: 'approved',
      adminNotes: req.body.adminNotes || ''
    },
    { new: true }
  );

   if (!application) {
    return res.status(404).json({ error: 'Application not found' });
  }

  // Update user's role to 'rider'
  await User.findOneAndUpdate(
    { uid: application.userId },
    { role: 'rider' }
  );

  // The activity log is the audit trail of who did what, so it is recorded
  // only after the change has succeeded - a failed write must not fail the
  // request that already completed.
  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.user.name || req.user.email,
    action: 'approve_rider',
    targetType: 'rider',
    targetId: application.userId,
    targetName: application.name,
    details: {
      applicationId: String(application._id),
      adminNotes: req.body.adminNotes || '',
    },
  });

   res.status(200).json({ message: 'Application approved', application });

})

//  PUT /api/rider-applications/:id/reject (Admin only)
export const rejectRiderApplication = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const application = await RiderApplication.findByIdAndUpdate(
    id,
    { 
      status: 'rejected',
      adminNotes: req.body.reason || ''
    },
    { new: true }
  );

  if (!application) {
    return res.status(404).json({ error: 'Application not found' });
  }

  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.user.name || req.user.email,
    action: 'reject_rider',
    targetType: 'rider',
    targetId: application.userId,
    targetName: application.name,
    details: {
      applicationId: String(application._id),
      reason: req.body.reason || '',
    },
  });

  res.status(200).json({ message: 'Application rejected', application });
});

// PUT /api/rider-applications/:id/deactivate (Admin only)
export const deactivateRiderApplication = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const application = await RiderApplication.findByIdAndUpdate(
    id,
    {
      status: 'deactivated',
      adminNotes: req.body.reason || ''
    }, {
      new: true
    }
  );
  if(!application){
     return res.status(404).json({ error: 'Application not found' });
  }
     // The activity log is the audit trail of who did what, so it is recorded
     // only after the change has succeeded.
     await logAdminAction({
       actorUid: req.user.uid,
       actorName: req.user.name || req.user.email,
       action: 'deactivate_rider',
       targetType: 'rider',
       targetId: application.userId,
       targetName: application.name,
       details: {
         applicationId: String(application._id),
         reason: req.body.reason || '',
       },
     });

     // Revert user's role back to 'customer'
  await User.findOneAndUpdate(
    { uid: application.userId },
    { role: 'customer' }
  );
    res.status(200).json({ message: 'Rider deactivated', application });

});

export default {
  submitRiderApplication,
  getAllRiderApplications,
  approveRiderApplication,
  rejectRiderApplication,
  deactivateRiderApplication
};