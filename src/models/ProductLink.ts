import mongoose from 'mongoose';

/**
 * A manual cross-store correction: "this Knuspr product is the EDEKA one I buy".
 *
 * This is display only. It never merges purchases, never changes a rate, a stock
 * estimate, a "due" decision or an occasion — the shopper asked to see the other
 * store's row next to the product, nothing more. Because of that it lives in its
 * own collection instead of `ProductGroup.members[]`: the learning pipeline has
 * no reason to read it, and `src/lib/bot/**` is lint-forbidden from importing it.
 *
 * Automatic name matches are not stored at all; they are recomputed on every read
 * from the receipts the shopper already has. Only a row here means a human
 * overrode the matcher.
 */
const productLinkSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    knusprProductId: { type: Number, required: true },
    /** The EDEKA bucket key from `aggregateEdeka` (`productKey()` of a receipt row). */
    edekaTextKey: { type: String, required: true },
    /** A manual row is certain by definition, so it always wins over a name match. */
    confidence: { type: Number, default: 1, min: 0, max: 1 },
    source: { type: String, enum: ['manual'], default: 'manual' },
  },
  { timestamps: true }
);

// One Knuspr product points at one EDEKA product; correcting it updates the row.
productLinkSchema.index({ userId: 1, knusprProductId: 1 }, { unique: true });

export default mongoose.models.ProductLink || mongoose.model('ProductLink', productLinkSchema);
