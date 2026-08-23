import Setting from '../models/setting.model.js';
import asyncHandler from '../middleware/asyncHandler.js';

/**
 * GET /api/settings
 * Get all settings (public or admin only)
 */
export const getSettings = asyncHandler(async (req, res) => {
  let settings = await Setting.findOne();
  
  // If no settings exist, create default ones
  if (!settings) {
    settings = await Setting.create({});
  }

  return res.status(200).json(settings);
});

/**
 * PUT /api/settings
 * Update settings (admin only)
 */
export const updateSettings = asyncHandler(async (req, res) => {
  const updateData = req.body;

  // Remove sensitive fields that shouldn't be updated via this endpoint
  delete updateData._id;
  delete updateData.createdAt;
  delete updateData.updatedAt;

  let settings = await Setting.findOne();

  if (!settings) {
    settings = await Setting.create(updateData);
  } else {
    settings = await Setting.findOneAndUpdate({}, updateData, {
      new: true,
      runValidators: true,
    });
  }

  return res.status(200).json({
    message: 'Settings updated successfully',
    settings,
  });
});

/**
 * PATCH /api/settings/pricing
 * Update pricing settings only (admin only)
 */
export const updatePricingSettings = asyncHandler(async (req, res) => {
  const pricingData = req.body;

  let settings = await Setting.findOne();

  if (!settings) {
    settings = await Setting.create({ pricing: pricingData });
  } else {
    settings.pricing = { ...settings.pricing, ...pricingData };
    await settings.save();
  }

  return res.status(200).json({
    message: 'Pricing settings updated successfully',
    settings,
  });
});

/**
 * PATCH /api/settings/system
 * Update system settings only (admin only)
 */
export const updateSystemSettings = asyncHandler(async (req, res) => {
  const systemData = req.body;

  let settings = await Setting.findOne();

  if (!settings) {
    settings = await Setting.create({ system: systemData });
  } else {
    settings.system = { ...settings.system, ...systemData };
    await settings.save();
  }

  return res.status(200).json({
    message: 'System settings updated successfully',
    settings,
  });
});

/**
 * GET /api/settings/public
 * Get public settings (no auth required)
 */
export const getPublicSettings = asyncHandler(async (req, res) => {
  const settings = await Setting.findOne().select(
    'appInfo system.maintenanceMode system.maintenanceMessage businessHours'
  );

  return res.status(200).json(settings || {});
});