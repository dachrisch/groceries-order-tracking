import mongoose from 'mongoose';

const botRunItemSchema = new mongoose.Schema({
  productId: { type: Number, required: true },
  name: { type: String, required: true },
  qty: { type: Number, required: true },
  reason: { type: String },
  groupKey: { type: String },
  price: { type: Number },
  /** Set when the item came only from this occasion; used to learn amounts from deliveries. */
  occasionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Occasion' },
  servings: { type: Number },
}, { _id: false });

const botRunSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  intent: {
    type: {
      type: String,
      enum: ['weekly', 'occasion', 'plan'],
      required: true,
    },
    occasion: { type: String },
    occasionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Occasion' },
    servings: { type: Number },
    /** Human summary of a multi-action plan, e.g. "Weekly till Sun + Pizza ×6 (Wed)". */
    summary: { type: String },
  },
  items: [botRunItemSchema],
  totalPrice: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['in-cart', 'undone', 'delivered', 'partially-delivered'],
    default: 'in-cart',
  },
  matchedOrderId: { type: Number },
  deliveredItemCount: { type: Number },
}, { timestamps: true });

botRunSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.models.BotRun || mongoose.model('BotRun', botRunSchema);
