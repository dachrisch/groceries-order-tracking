import mongoose, { Document, Schema } from 'mongoose';

/**
 * Supported integration providers.
 */
export enum IntegrationProvider {
  KNUSPR = 'knuspr',
}

/**
 * Interface for the Integration model.
 */
export interface IIntegration extends Document {
  userId: mongoose.Types.ObjectId;
  provider: IntegrationProvider;
  /** Encrypted JSON string of credentials (e.g., { email, password }) */
  encryptedCredentials?: string;
  /** Encrypted JSON string of full request headers */
  headers?: string;
  /** Encrypted JSON string of session cookies */
  cookies?: string;
  /** Timestamp of the last successful sync */
  lastSyncAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const integrationSchema = new Schema<IIntegration>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  provider: {
    type: String,
    enum: Object.values(IntegrationProvider),
    required: true
  },
  encryptedCredentials: { type: String },
  headers: { type: String },
  cookies: { type: String },
  lastSyncAt: { type: Date }
}, { timestamps: true });

// Ensure one document per (userId, provider) pair
integrationSchema.index({ userId: 1, provider: 1 }, { unique: true });

export default mongoose.models.Integration || mongoose.model<IIntegration>('Integration', integrationSchema);
