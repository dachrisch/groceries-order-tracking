import mongoose from 'mongoose';

/**
 * An occasion the bot learned from your order history ("Pizza night",
 * "Birthday brunch"). Quantities are stored per serving so "pizza for 6"
 * can be scaled from the 4-person baskets the detector saw.
 */
const occasionItemSchema = new mongoose.Schema({
  productId: { type: Number, required: true },
  name: { type: String, required: true },
  groupKey: { type: String },
  /** Base units (g/ml/pieces) per serving. */
  qtyPerServing: { type: Number, required: true },
  packSize: { type: Number, required: true },
  /** Core items are always included; optional items only when already known. */
  core: { type: Boolean, default: true },
}, { _id: false });

const occasionSourceSchema = new mongoose.Schema({
  orderId: { type: Number, required: true },
  productIds: [{ type: Number }],
}, { _id: false });

const occasionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  key: { type: String, required: true },
  name: { type: String, required: true },
  aliases: [{ type: String }],
  items: [occasionItemSchema],
  basisServings: { type: Number, default: 4 },
  occurrences: { type: Number, default: 0 },
  lastSeen: { type: Date },
  sourceOrders: [occasionSourceSchema],
  /** Set when the user corrected this occasion from chat; rebuilds keep items as-is. */
  manualEdits: { type: Boolean, default: false },
}, { timestamps: true });

occasionSchema.index({ userId: 1, key: 1 }, { unique: true });

export default mongoose.models.Occasion || mongoose.model('Occasion', occasionSchema);
