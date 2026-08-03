import RiderApplication from '../models/riderApplication.model.js';
import asyncHandler from '../middleware/asyncHandler.js';

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