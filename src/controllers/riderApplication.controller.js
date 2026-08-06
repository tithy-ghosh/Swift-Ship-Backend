import RiderApplication from '../models/riderApplication.model.js';
import asyncHandler from '../middleware/asyncHandler.js';
import User from '../models/user.model.js';
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
    { userId: application.userId },
    { role: 'rider' }
  );
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

  res.status(200).json({ message: 'Application rejected', application });
});

export default {
  submitRiderApplication,
  getAllRiderApplications,
  approveRiderApplication,
  rejectRiderApplication,
};