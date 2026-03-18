import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const MONGODB_URI = process.env.MONGODB_URI;
const NODE_ENV = process.env.NODE_ENV || 'development';

let mongoMemoryServer: MongoMemoryServer | null = null;

export async function connectDB() {
  if (mongoose.connection.readyState >= 1) return;

  let uri = MONGODB_URI;

  // Use in-memory MongoDB for local development if MONGODB_URI is not set
  if (!uri && NODE_ENV !== 'production') {
    console.log('Starting in-memory MongoDB server...');
    mongoMemoryServer = await MongoMemoryServer.create();
    uri = mongoMemoryServer.getUri();
  }

  if (!uri) {
    console.error('FATAL: MONGODB_URI environment variable is not set and could not start in-memory server.');
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);
    console.log(`MongoDB Connected: ${uri.startsWith('mongodb+srv') ? 'Remote Cluster' : (mongoMemoryServer ? 'In-Memory' : 'Local Instance')}`);
  } catch (err) {
    console.error('MongoDB Connection Error:', err);
    process.exit(1);
  }
}
