import mongoose from 'mongoose';

const botSettingsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  maxEuro: { type: Number, default: 150 },
  maxItems: { type: Number, default: 30 },
  horizonDays: { type: Number, default: 7 },
  deliveryLeadDays: { type: Number, default: 2 },
  opencodeEnabled: { type: Boolean, default: true },
  /** What the last occasion detection looked at, shown when nothing was found. */
  lastDetection: {
    at: { type: Date },
    ordersScanned: { type: Number },
    candidateBaskets: { type: Number },
    clusters: { type: Number },
    kept: { type: Number },
  },
  /** Background recipe discovery runs at most daily and only when groups changed. */
  recipeDiscovery: {
    at: { type: Date },
    groupsHash: { type: String },
  },
}, { timestamps: true });

export interface BotSettingsShape {
  maxEuro: number;
  maxItems: number;
  horizonDays: number;
  deliveryLeadDays: number;
  opencodeEnabled: boolean;
}

export const BOT_SETTINGS_DEFAULTS: BotSettingsShape = {
  maxEuro: 150,
  maxItems: 30,
  horizonDays: 7,
  deliveryLeadDays: 2,
  opencodeEnabled: true,
};

export default mongoose.models.BotSettings || mongoose.model('BotSettings', botSettingsSchema);
