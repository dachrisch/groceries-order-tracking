import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Stores third-party integration credentials and session data per user.
 * One document per (userId, provider) pair.
 */
const integrationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  provider: { type: String, required: true }, // e.g., 'knuspr'
  headers: { type: Object, required: true }, // Full curl headers
  cookies: { type: Object, required: true },
  lastSync: { type: Date, default: Date.now }
}, { timestamps: true });

integrationSchema.index({ userId: 1, provider: 1 }, { unique: true });

export default mongoose.models.Integration || mongoose.model('Integration', integrationSchema);
