import mongoose from 'mongoose';

const settingSchema = new mongoose.Schema(
  {
    // Delivery Pricing
    pricing: {
      documentWithinCityRate: {
        type: Number,
        default: 50,
        min: 0,
      },
      documentOutsideCityRate: {
        type: Number,
        default: 80,
        min: 0,
      },
      nonDocumentBaseWithinCityRate: {
        type: Number,
        default: 80,
        min: 0,
      },
      nonDocumentBaseOutsideCityRate: {
        type: Number,
        default: 130,
        min: 0,
      },
      maxBaseWeightKg: {
        type: Number,
        default: 3,
        min: 0,
      },
      extraWeightRatePerKg: {
        type: Number,
        default: 20,
        min: 0,
      },
      outsideCityExtraCharge: {
        type: Number,
        default: 20,
        min: 0,
      },
      minimumCharge: {
        type: Number,
        default: 40,
        min: 0,
      },
    },

    // Service Zones
    serviceZones: [
      {
        name: { type: String, required: true, trim: true },
        districts: [String],
        isActive: { type: Boolean, default: true },
      },
    ],

    // System Settings
    system: {
      maintenanceMode: {
        type: Boolean,
        default: false,
      },
      maintenanceMessage: {
        type: String,
        default: 'System is under maintenance. Please try again later.',
      },
      allowNewRegistrations: {
        type: Boolean,
        default: true,
      },
      allowNewParcelBookings: {
        type: Boolean,
        default: true,
      },
    },

    // App Information
    appInfo: {
      appName: {
        type: String,
        default: 'SwiftShip',
      },
      supportEmail: {
        type: String,
        default: 'support@swiftship.com',
      },
      supportPhone: {
        type: String,
        default: '+880 1XXX-XXXXXX',
      },
      version: {
        type: String,
        default: '1.0.0',
      },
    },

    // Business Hours
    businessHours: {
      isOpen24_7: {
        type: Boolean,
        default: true,
      },
      openingTime: {
        type: String,
        default: '08:00',
      },
      closingTime: {
        type: String,
        default: '22:00',
      },
    },
  },
  {
    timestamps: true,
  }
);

// Ensure only one settings document exists
settingSchema.index({ isDefault: 1 }, { unique: true, sparse: true });

const Setting = mongoose.model('Setting', settingSchema);

export default Setting;