import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://homeuser:unvisited-straggler6-spirits-envoy-antler@cluster0.mhyen.mongodb.net/groceries_tracking?retryWrites=true&w=majority&appName=Cluster0';

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
