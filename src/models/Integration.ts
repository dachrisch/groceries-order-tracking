import { Schema, model, Document } from 'mongoose';
import { IntegrationProvider } from '../types/enums'; // Assuming this enum exists

// Interface for the Integration document
interface IIntegration extends Document {
  userId: Schema.Types.ObjectId;
  provider: IntegrationProvider; // Use enum
  encryptedCredentials: {
    headers: string; // Storing encrypted JSON string of headers
    cookies: string; // Storing encrypted JSON string of cookies
  };
  lastSyncAt?: Date; // Or use timestamps: true
}

const integrationSchema = new Schema<IIntegration>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  provider: { type: String, required: true, enum: IntegrationProvider, index: true },
  encryptedCredentials: {
    headers: { type: String, required: true },
    cookies: { type: String, required: true },
  },
  // lastSyncAt: { type: Date, default: Date.now } // If timestamps: true is used, this might be auto-managed
}, { timestamps: true }); // Using timestamps for auto-managed createdAt/updatedAt

// Ensure unique provider per user
integrationSchema.index({ userId: 1, provider: 1 }, { unique: true });

export default model<IIntegration>('Integration', integrationSchema);
