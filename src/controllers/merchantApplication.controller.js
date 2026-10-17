import MerchantApplication from '../models/merchantApplication.model.js';
import asyncHandler from '../middleware/asyncHandler.js';
import User from '../models/user.model.js';
import { logAdminAction } from '../services/activity-log.service.js';

// POST /api/merchant-applications
export const submitMerchantApplication = asyncHandler(async (req, res) => {
  const { uid } = req.user; // From verifyToken middleware
  const applicationData = req.body;

  // Prevent duplicate active applications
  const existing = await MerchantApplication.findOne({
    userId: uid,
    status: { $in: ['pending', 'approved'] },
  });

  if (existing) {
    return res.status(400).json({
      error: 'You already have an active merchant application.',
    });
  }

  const newApplication = await MerchantApplication.create({
    userId: uid,
    ...applicationData,
    status: 'pending', // Enforce pending status on creation
  });

  res.status(201).json(newApplication);
});

// GET /api/merchant-applications (Admin only - get all applications)
export const getAllMerchantApplications = asyncHandler(async (req, res) => {
  const { status } = req.query;

  const query = status ? { status } : {};
  const applications = await MerchantApplication.find(query).sort({ createdAt: -1 });

  res.status(200).json(applications);
});

// PUT /api/merchant-applications/:id/approve (Admin only)
export const approveMerchantApplication = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const application = await MerchantApplication.findByIdAndUpdate(
    id,
    {
      status: 'approved',
      adminNotes: req.body.adminNotes || '',
    },
    { new: true }
  );

  if (!application) {
    return res.status(404).json({ error: 'Application not found' });
  }

  // Promote the applicant's account to the merchant role. The frontend's
  // navbar/sidebar key off this value, so it is the whole visible "UI change".
  await User.findOneAndUpdate({ uid: application.userId }, { role: 'merchant' });

  // The activity log is the audit trail of who did what, so it is recorded
  // only after the change has succeeded.
  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.user.name || req.user.email,
    action: 'approve_merchant',
    targetType: 'merchant',
    targetId: application.userId,
    targetName: application.name,
    details: {
      applicationId: String(application._id),
      adminNotes: req.body.adminNotes || '',
    },
  });

  res.status(200).json({ message: 'Application approved', application });
});

// PUT /api/merchant-applications/:id/reject (Admin only)
export const rejectMerchantApplication = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const application = await MerchantApplication.findByIdAndUpdate(
    id,
    {
      status: 'rejected',
      adminNotes: req.body.reason || '',
    },
    { new: true }
  );

  if (!application) {
    return res.status(404).json({ error: 'Application not found' });
  }

  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.user.name || req.user.email,
    action: 'reject_merchant',
    targetType: 'merchant',
    targetId: application.userId,
    targetName: application.name,
    details: {
      applicationId: String(application._id),
      reason: req.body.reason || '',
    },
  });

  res.status(200).json({ message: 'Application rejected', application });
});

// PUT /api/merchant-applications/:id/deactivate (Admin only)
export const deactivateMerchantApplication = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const application = await MerchantApplication.findByIdAndUpdate(
    id,
    {
      status: 'deactivated',
      adminNotes: req.body.reason || '',
    },
    { new: true }
  );

  if (!application) {
    return res.status(404).json({ error: 'Application not found' });
  }

  // The activity log is the audit trail of who did what, so it is recorded
  // only after the change has succeeded.
  await logAdminAction({
    actorUid: req.user.uid,
    actorName: req.user.name || req.user.email,
    action: 'deactivate_merchant',
    targetType: 'merchant',
    targetId: application.userId,
    targetName: application.name,
    details: {
      applicationId: String(application._id),
      reason: req.body.reason || '',
    },
  });

  // Mirror the rider flow: pulling the merchant off the platform drops their
  // account back to customer so the merchant-only UI disappears.
  await User.findOneAndUpdate(
    { uid: application.userId },
    { role: 'customer' }
  );

  res.status(200).json({ message: 'Merchant deactivated', application });
});

export default {
  submitMerchantApplication,
  getAllMerchantApplications,
  approveMerchantApplication,
  rejectMerchantApplication,
  deactivateMerchantApplication,
};
