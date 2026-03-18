import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  knusprCredentials: {
    headers: { type: Map, of: String },
    cookie: { type: String },
    lastImport: { type: Date }
  }
}, { timestamps: true });

export default mongoose.models.User || mongoose.model('User', userSchema);
