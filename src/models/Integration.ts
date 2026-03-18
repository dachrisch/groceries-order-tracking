import mongoose from 'mongoose';

/**
 * Stores encrypted third-party integration credentials per user.
 * One document per (userId, provider) pair.
 * encryptedCredentials is a JSON object encrypted with the user's derived key.
 */
const integrationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  provider: { type: String, required: true }, // e.g. 'knuspr'
  encryptedCredentials: { type: String, required: true },
  lastSyncAt: { type: Date, default: null },
}, { timestamps: true });

integrationSchema.index({ userId: 1, provider: 1 }, { unique: true });

export default mongoose.models.Integration || mongoose.model('Integration', integrationSchema);
