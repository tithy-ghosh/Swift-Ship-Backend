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

    // Rider Compensation
    //
    // A rider's pay is the 40-60 split of the delivery's fare: they keep
    // `riderSharePercent` of the customer's cost, the company keeps the rest.
    // `baseFare`/`perKmRate`/`minFare` price a cross-district LEG's own pool
    // (a whole-route delivery is priced at the customer's cost instead).
    //
    // A rider's actual pay for a delivery is snapshotted onto the parcel at
    // accept time, so editing these never rewrites history.
    riderPayout: {
      /** The rider's percentage of each delivery's fare. */
      riderSharePercent: {
        type: Number,
        default: 40,
        min: 0,
        max: 100,
      },
      /** The company's percentage. Stored explicitly so both halves are visible. */
      companySharePercent: {
        type: Number,
        default: 60,
        min: 0,
        max: 100,
      },
      /** A leg's pool base, before any distance component. */
      baseFare: {
        type: Number,
        default: 40,
        min: 0,
      },
      /** Added per km of service-centre to service-centre distance. */
      perKmRate: {
        type: Number,
        default: 12,
        min: 0,
      },
      /** Floor on the rider's fare share, so short hops stay worth accepting. */
      minFare: {
        type: Number,
        default: 40,
        min: 0,
      },
      bonus: {
        /** Grant a bonus once the daily target is reached. */
        enabled: { type: Boolean, default: true },
        /** Deliveries per day that unlock the bonus. */
        dailyTarget: { type: Number, default: 6, min: 0 },
        /** Bonus amount in BDT. Paid to the rider in full, on top of the split. */
        amount: { type: Number, default: 100, min: 0 },
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