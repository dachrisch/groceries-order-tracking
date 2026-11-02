import mongoose from 'mongoose';

/**
 * A group of near-identical Knuspr products (e.g. "Bio Vollmilch 1l" and
 * "Knuspr Vollmilch 1l"). All consumption/occasion learning works on groups,
 * because Knuspr gives the same product different IDs over time.
 *
 * Groups are rebuilt from rules after every sync. Groups with `manual: true`
 * are created by the user and are never touched by a rebuild.
 */
const productGroupSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  key: { type: String, required: true },
  label: { type: String, required: true },
  productIds: [{ type: Number }],
  manual: { type: Boolean, default: false },
}, { timestamps: true });

productGroupSchema.index({ userId: 1, key: 1 }, { unique: true });
productGroupSchema.index({ userId: 1, manual: 1 });

export default mongoose.models.ProductGroup || mongoose.model('ProductGroup', productGroupSchema);
