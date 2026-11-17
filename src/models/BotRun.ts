import mongoose from 'mongoose';

const botRunItemSchema = new mongoose.Schema({
  /** Knuspr product id. An EDEKA list line may have none and be identified by `textKey`. */
  productId: { type: Number },
  /** Which provider's basket this line was written to. Older runs predate it and are Knuspr. */
  provider: { type: String, enum: ['knuspr', 'edeka'] },
  /** EDEKA free-text identity: a line with no catalogue id is remembered by its name. */
  textKey: { type: String },
  /** EASY Shopper row id, when the write returned one, so undo removes exactly that row. */
  listItemGuid: { type: String },
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
  /**
   * Where the items went. A plain cart run is the default, so every run written
   * before destinations existed stays a Knuspr run without a migration.
   */
  destination: {
    type: String,
    enum: ['knuspr-cart', 'edeka-list', 'checklist'],
    default: 'knuspr-cart',
  },
  /**
   * Where the shopper was when the run happened. The default destination is
   * derived from this, so recording it keeps a derived default auditable later.
   */
  locationContext: {
    source: { type: String },
    city: { type: String },
    country: { type: String },
  },
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
