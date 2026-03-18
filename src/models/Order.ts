import mongoose from 'mongoose';

const orderItemSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  name: { type: String, required: true },
  unit: { type: String },
  textualAmount: { type: String },
  amount: { type: Number },
  images: [String],
  priceComposition: {
    total: {
      amount: { type: Number },
      currency: { type: String }
    },
    unit: {
      amount: { type: Number },
      currency: { type: String }
    }
  },
  orderFieldId: { type: Number },
  compensated: { type: Boolean }
});

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  id: { type: Number, required: true },
  itemsCount: { type: Number },
  priceComposition: {
    total: {
      amount: { type: Number },
      currency: { type: String }
    },
    goods: {
      amount: { type: Number },
      currency: { type: String }
    },
    delivery: {
      amount: { type: Number },
      currency: { type: String }
    },
    creditsUsed: {
      amount: { type: Number },
      currency: { type: String }
    },
    courierTip: {
      amount: { type: Number },
      currency: { type: String }
    }
  },
  orderTime: { type: String },
  orderTimeDate: { type: Date, required: true },
  deliveryType: { type: String },
  address: { type: String },
  state: { type: String },
  items: [orderItemSchema]
}, { timestamps: true });

// Create an index for unique orders per user
orderSchema.index({ userId: 1, id: 1 }, { unique: true });

export default mongoose.models.Order || mongoose.model('Order', orderSchema);
