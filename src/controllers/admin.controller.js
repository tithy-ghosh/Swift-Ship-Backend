import User from '../models/user.model.js';
import Parcel from '../models/parcel.model.js'; 
import Payment from '../models/payment.model.js'; 
import RiderApplication from '../models/riderApplication.model.js';
import asyncHandler from '../middleware/asyncHandler.js';

export const getAdminStats = asyncHandler(async (req, res) => {
  // 1. Count Users
  const totalUsers = await User.countDocuments();

  // 2. Count Rider Applications
  const pendingRiders = await RiderApplication.countDocuments({ status: 'pending' });
  const activeRiders = await RiderApplication.countDocuments({ status: 'approved' });

  // 3. Count Parcels 
  const totalParcels = await Parcel.countDocuments();
  const pendingParcels = await Parcel.countDocuments({ status: 'pending' }); // Or whatever your pending status is called
  const deliveredParcels = await Parcel.countDocuments({ status: 'delivered' }); 

  // 4. Calculate Total Revenue 
 
  const revenueData = await Payment.aggregate([
    { $match: { status: 'paid' } }, // Change 'paid' to whatever your success status is (e.g., 'success', 'completed')
    { $group: { _id: null, totalRevenue: { $sum: '$amount' } } } // Change 'amount' to your actual price field name
  ]);
  
  const totalRevenue = revenueData.length > 0 ? revenueData[0].totalRevenue : 0;

  res.status(200).json({
    totalUsers,
    pendingRiders,
    activeRiders,
    totalParcels,
    pendingParcels,
    deliveredParcels,
    totalRevenue,
  });
});