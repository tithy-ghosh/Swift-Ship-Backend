import mongoose from 'mongoose'

const parcelSchema = new mongoose.Schema(
  {
    trackingId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['document', 'non-document'],
      required: true,
    },
    title: {
      type: String,
      default: '',
    },
    weight: {
      type: Number,
      default: 0,
    },

    // Sender
    senderName: { type: String, required: true },
    senderContact: { type: String, required: true },
    senderRegion: { type: String, required: true },
    senderServiceCenter: { type: String, required: true },
    senderAddress: { type: String, default: '' },
    pickupInstruction: { type: String, default: '' },

    // Receiver
    receiverName: { type: String, required: true },
    receiverContact: { type: String, required: true },
    receiverRegion: { type: String, required: true },
    receiverServiceCenter: { type: String, required: true },
    receiverAddress: { type: String, default: '' },
    deliveryInstruction: { type: String, default: '' },

    // Pricing
    deliveryCost: { type: Number, required: true },
    deliveryZone: { type: String, required: true },
    costBreakdown: [
      {
        label: String,
        amount: Number,
      },
    ],

    // Owner
    createdBy: {
      uid: { type: String, required: true },
      name: { type: String },
      email: { type: String },
    },

    // ---- Rider assignment ----
    // A parcel is the job. There is no separate Job/Assignment collection: an
    // unassigned parcel is an offer, an assigned one is a delivery in progress.
    // `null` here is what makes a parcel claimable, and the accept endpoint
    // relies on that null as its atomic guard.

    /**
     * Which delivery model this parcel runs on.
     *
     *   null      - same-district route; one rider does pickup AND delivery.
     *   'pickup'  - cross-district; leg 1 rider collects and drops at the godown.
     *   'delivery'- cross-district; leg 2 rider collects from the godown and
     *               delivers. Staff flips the parcel from 'pickup' to
     *               'delivery' once it arrives at the destination godown.
     */
    leg: { type: String, enum: [null, 'pickup', 'delivery'], default: null },

    /** The rider currently holding an active leg. Doubles as the claim guard. */
    assignedRider: {
      uid: { type: String, default: null },
      name: { type: String, default: '' },
    },
    assignedAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    /** Service-centre to service-centre distance, resolved on accept. */
    distanceKm: { type: Number, default: null },

    /**
     * The listed price of one leg of rider work, plus that leg's settlement.
     *
     * Two legs exist because a cross-district parcel is split between two
     * riders, each of whom is paid (and settled) separately. A same-district
     * parcel only ever fills `delivery` - its one rider does the whole route,
     * and the "delivery leg" is simply that whole route.
     *
     * The snapshot is frozen at accept time: if an admin changes the rate card
     * tomorrow, this rider's job still pays what it quoted today.
     *
     *   total         - the fare pool the 40-60 split applies to. The
     *                   customer's own delivery cost for a whole-route
     *                   delivery, or the leg rate-card fare for a leg of a
     *                   cross-district journey.
     *   riderShare    - the rider's money: their share of the fare plus the
     *                   whole bonus. This is what settlement pays out.
     *   companyShare  - what the company keeps from the fare pool.
     *
     * `status` is the settlement state mirrored on the earnings screen:
     * 'pending' until an admin marks the payout done.
     */
    riderPayouts: {
      pickup: {
        baseFare: { type: Number, default: 0 },
        perKmRate: { type: Number, default: 0 },
        distanceKm: { type: Number, default: null },
        bonus: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
        /**
         * The rider's entitlement for this leg: their share of the fare plus
         * the whole daily bonus. This is what the rider is paid.
         */
        riderShare: { type: Number, default: 0 },
        /** What the company keeps from the fare pool, after the rider's share. */
        companyShare: { type: Number, default: 0 },
        // Which rider earned this leg. Copied from `assignedRider` at accept,
        // because after a handoff the parcel's assignedRider points at the
        // *next* leg's rider and the pickup payout would lose its owner.
        rider: {
          uid: { type: String, default: '' },
          name: { type: String, default: '' },
        },
        status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
        batchId: { type: String, default: '' },
        paidAt: { type: Date, default: null },
        /**
         * When the rider actually finished this leg.
         *
         * Snapshots are written at accept time, so `total` exists long before
         * anybody has earned it. Settlement worklists read this field rather
         * than `total` alone - without it an admin could mark a leg paid while
         * the rider is still halfway to the pickup.
         */
        earnedAt: { type: Date, default: null },
      },
      delivery: {
        baseFare: { type: Number, default: 0 },
        perKmRate: { type: Number, default: 0 },
        distanceKm: { type: Number, default: null },
        bonus: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
        /**
         * The rider's entitlement for this leg: their share of the fare plus
         * the whole daily bonus. This is what the rider is paid.
         */
        riderShare: { type: Number, default: 0 },
        /** What the company keeps from the fare pool, after the rider's share. */
        companyShare: { type: Number, default: 0 },
        rider: {
          uid: { type: String, default: '' },
          name: { type: String, default: '' },
        },
        status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
        batchId: { type: String, default: '' },
        paidAt: { type: Date, default: null },
        /**
         * When the rider actually finished this leg.
         *
         * Snapshots are written at accept time, so `total` exists long before
         * anybody has earned it. Settlement worklists read this field rather
         * than `total` alone - without it an admin could mark a leg paid while
         * the rider is still halfway to the pickup.
         */
        earnedAt: { type: Date, default: null },
      },
    },

    /**
     * Cash the rider collected from the customer and must deposit. Kept
     * separate from the payout legs because it is money the rider is holding,
     * not money they earned - the earnings screen must never add the two.
     */
    cod: {
      required: { type: Boolean, default: false },
      amount: { type: Number, default: 0 },
      collectedAt: { type: Date, default: null },
      /**
       * The rider declaring they have physically handed the cash to the admin.
       * `depositStatus` stays admin-owned: the rider may say the money left
       * their pocket, only the admin may say it was received. An admin cannot
       * confirm `deposited` until this is set, which turns the admin's button
       * into a real confirmation rather than a blind mark.
       */
      handedOverAt: { type: Date, default: null },
      depositStatus: {
        type: String,
        enum: ['not_required', 'pending', 'deposited'],
        default: 'not_required',
      },
      depositedAt: { type: Date, default: null },
    },

    /** Problems the rider reported mid-delivery. Append-only. */
    issues: [
      {
        reason: { type: String, required: true },
        note: { type: String, default: '' },
        reportedAt: { type: Date, default: Date.now },
        reportedBy: { uid: { type: String, required: true } },
      },
    ],

    /**
     * Why a parcel was cancelled, and by whom.
     *
     * Tracking holds the timeline and the activity log holds the admin's
     * action, but neither is queryable for a cancellation *report*: the log is
     * admin-only and the rider path records no reason at all. Storing it here
     * gives the analytics page one place to group cancellations by reason.
     *
     * Admin cancellations carry the typed reason; rider cancellations carry the
     * fixed sentinel `stopped-by-rider` (the rider app does not collect one);
     * merchant cancellations carry the merchant's typed reason. Parcels
     * cancelled before this field existed stay empty and are grouped as
     * "Unspecified" by the report.
     */
    cancellation: {
      reason: { type: String, default: '' },
      cancelledAt: { type: Date, default: null },
      cancelledBy: {
        uid: { type: String, default: '' },
        name: { type: String, default: '' },
        role: { type: String, enum: ['', 'admin', 'rider', 'merchant'], default: '' },
      },
    },
  },
  { timestamps: true }
)

// The rider job feed filters on leg + district + unassigned, sorted by age.
// One index per district column because the feed is a $or of three branches:
// same-district and pickup both read senderServiceCenter, delivery reads
// receiverServiceCenter.
parcelSchema.index({ senderServiceCenter: 1, 'assignedRider.uid': 1, createdAt: -1 })
parcelSchema.index({ receiverServiceCenter: 1, 'assignedRider.uid': 1, createdAt: -1 })
// The admin payout list filters on settlement state of a leg.
parcelSchema.index({ 'riderPayouts.delivery.status': 1, updatedAt: -1 })
parcelSchema.index({ 'riderPayouts.pickup.status': 1, updatedAt: -1 })
// Analytics dates parcels by creation ("new parcels this window") and ranks
// riders by legs they finished in the window.
parcelSchema.index({ createdAt: -1 })
parcelSchema.index({ 'riderPayouts.delivery.earnedAt': -1 })
parcelSchema.index({ 'riderPayouts.pickup.earnedAt': -1 })

const Parcel = mongoose.model('Parcel', parcelSchema)

export default Parcel
