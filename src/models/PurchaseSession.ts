import mongoose from 'mongoose';

/**
 * In-store purchase captured from the EASY Shopper app (EDEKA/Marktkauf/WEZ).
 *
 * Deliberately separate from `Order` (Knuspr): mixing a weekly delivery and an
 * in-store run would double-count consumption. Consumers opt in per source.
 */
const purchaseItemSchema = new mongoose.Schema(
  {
    brand: { type: String, default: null },
    name: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    unitPrice: { type: Number, default: null },
    lineTotal: { type: Number, default: null },
    /** Leergut / bottle-deposit return: money back, not a product purchase. */
    isCredit: { type: Boolean, default: false },
    /** Row text exactly as the app rendered it, kept for re-parsing and audit. */
    raw: { type: String },
  },
  { _id: false }
);

const purchaseSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: String, default: 'easyshopper', index: true },
    /** Stable key from the capture: `<date> <time>|<store>|<total>`. */
    key: { type: String, required: true },
    purchasedAt: { type: Date, required: true },
    store: { type: String, required: true },
    /** CART (in-store self-scan) or EXPRESS. */
    type: { type: String },
    paymentMode: { type: String, default: null },
    /** 22-digit receipt number; only available ~24h after the purchase. */
    receiptBarcode: { type: String, default: null },
    /** Units the app reports (`ITEMS`), not the number of rows. */
    unitCount: { type: Number, default: null },
    total: { type: Number, required: true },
    /** `Σ item lineTotal − total`: non-zero means a receipt row was not captured. */
    difference: { type: Number, default: 0 },
    reconciled: { type: Boolean, default: true },
    items: [purchaseItemSchema],
  },
  { timestamps: true }
);

purchaseSessionSchema.index({ userId: 1, key: 1 }, { unique: true });
purchaseSessionSchema.index({ userId: 1, purchasedAt: -1 });

export default mongoose.models.PurchaseSession || mongoose.model('PurchaseSession', purchaseSessionSchema);
