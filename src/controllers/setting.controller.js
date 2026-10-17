import Setting from '../models/setting.model.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { invalidatePricingCache } from '../services/delivery-pricing.service.js';
import { invalidateRiderRateCardCache } from '../services/rider-payout.service.js';

/** Finds the single Setting document, creating it with defaults if missing. */
const findOrCreateSettings = async () => {
  let settings = await Setting.findOne();
  if (!settings) {
    settings = await Setting.create({});
  }
  return settings;
};

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

  invalidatePricingCache();
  // The same request can carry a new rider rate card (payout base, per-km
  // rate, or the 40-60 split), so its cache is cleared in the same breath.
  invalidateRiderRateCardCache();

  return res.status(200).json({
    message: 'Settings updated successfully',
    settings,
  });
});

/**
 * POST /api/settings/zones
 * Add a new service zone (admin only)
 */
export const createZone = asyncHandler(async (req, res) => {
  const { name, districts = [], isActive = true } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Zone name is required' });
  }

  const settings = await findOrCreateSettings();
  settings.serviceZones.push({ name: name.trim(), districts, isActive });
  await settings.save();

  const zone = settings.serviceZones[settings.serviceZones.length - 1];

  return res.status(201).json({
    message: 'Zone created successfully',
    zone,
    serviceZones: settings.serviceZones,
  });
});

/**
 * PATCH /api/settings/zones/:zoneId
 * Update a service zone (admin only)
 */
export const updateZone = asyncHandler(async (req, res) => {
  const { zoneId } = req.params;
  const { name, districts, isActive } = req.body;

  const settings = await findOrCreateSettings();
  const zone = settings.serviceZones.id(zoneId);

  if (!zone) {
    return res.status(404).json({ error: 'Zone not found' });
  }

  if (name !== undefined) {
    if (!name.trim()) {
      return res.status(400).json({ error: 'Zone name cannot be empty' });
    }
    zone.name = name.trim();
  }
  if (districts !== undefined) zone.districts = districts;
  if (isActive !== undefined) zone.isActive = isActive;

  await settings.save();

  return res.status(200).json({
    message: 'Zone updated successfully',
    zone,
    serviceZones: settings.serviceZones,
  });
});

/**
 * DELETE /api/settings/zones/:zoneId
 * Remove a service zone (admin only)
 */
export const deleteZone = asyncHandler(async (req, res) => {
  const { zoneId } = req.params;

  const settings = await findOrCreateSettings();
  const zone = settings.serviceZones.id(zoneId);

  if (!zone) {
    return res.status(404).json({ error: 'Zone not found' });
  }

  zone.deleteOne();
  await settings.save();

  return res.status(200).json({
    message: 'Zone deleted successfully',
    serviceZones: settings.serviceZones,
  });
});

/**
 * PATCH /api/settings/pricing
 * Update pricing settings only (admin only)
 */
export const updatePricingSettings = asyncHandler(async (req, res) => {
  const pricingData = req.body;

  const settings = await findOrCreateSettings();
  settings.pricing = { ...settings.toObject().pricing, ...pricingData };
  await settings.save();

  // Ensure the very next quote/parcel uses the new numbers, not a stale cache.
  invalidatePricingCache();

  return res.status(200).json({
    message: 'Pricing settings updated successfully',
    settings,
  });
});

/**
 * PATCH /api/settings/rider-payout
 * Update rider payout settings only (admin only)
 */
export const updateRiderPayoutSettings = asyncHandler(async (req, res) => {
  const riderPayoutData = req.body;

  const settings = await findOrCreateSettings();
  const current = settings.toObject().riderPayout || {};

  const next = {
    ...current,
    ...riderPayoutData,
    // Bonus is a nested group; merging it field-by-field keeps a partial call
    // from silently dropping the keys it did not mention.
    bonus: { ...(current.bonus || {}), ...(riderPayoutData.bonus || {}) },
  };

  // Whichever half of the split the caller sends, the other half is written
  // alongside it, so the stored document can never contradict itself.
  if (riderPayoutData.riderSharePercent !== undefined) {
    next.companySharePercent = 100 - Number(riderPayoutData.riderSharePercent);
  } else if (riderPayoutData.companySharePercent !== undefined) {
    next.riderSharePercent = 100 - Number(riderPayoutData.companySharePercent);
  }

  settings.riderPayout = next;
  await settings.save();

  // Riders see the new split on their next job fetch, not after the cache TTL.
  invalidateRiderRateCardCache();

  return res.status(200).json({
    message: 'Rider payout settings updated successfully',
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