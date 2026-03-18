import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'MONGODB_URI_REDACTED';

export async function connectDB() {
  if (mongoose.connection.readyState >= 1) return;

  try {
    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB Connected');
  } catch (err) {
    console.error('MongoDB Connection Error:', err);
    process.exit(1);
  }
}
