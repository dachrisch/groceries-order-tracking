import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { EJSON } from 'bson';

const MONGODB_URI = process.env.MONGODB_URI;
const NODE_ENV = process.env.NODE_ENV || 'development';

const DEV_SEED_FILE = path.join(process.cwd(), 'dev-seed.json');
export const MONGO_URI_FILE = '/tmp/groceries-mongo-uri';

async function seedFromFile() {
  if (!fs.existsSync(DEV_SEED_FILE)) return;

  try {
    const raw = fs.readFileSync(DEV_SEED_FILE, 'utf8');
    const seed = EJSON.parse(raw) as Record<string, any[]>;
    const db = mongoose.connection.db!;

    for (const [collection, docs] of Object.entries(seed)) {
      if (docs.length > 0) {
        await db.collection(collection).insertMany(docs);
        console.log(`  Seeded ${docs.length} docs → ${collection}`);
      }
    }
    console.log('Database seeded from dev-seed.json');
  } catch (err: any) {
    console.error('Seed failed:', err.message);
  }
}

export async function dumpDB() {
  if (mongoose.connection.readyState < 1) return;
  try {
    const db = mongoose.connection.db!;
    const collections = await db.listCollections().toArray();
    const seed: Record<string, any[]> = {};
    for (const col of collections) {
      seed[col.name] = await db.collection(col.name).find({}).toArray();
    }
    fs.writeFileSync(DEV_SEED_FILE, EJSON.stringify(seed, { relaxed: false }, 2));
    const total = Object.values(seed).reduce((n, d) => n + d.length, 0);
    console.log(`Database saved to dev-seed.json (${total} docs)`);
  } catch (err: any) {
    console.error('Auto-dump failed:', err.message);
  }
}

export async function connectDB() {
  if (mongoose.connection.readyState >= 1) return;

  let uri = MONGODB_URI;
  let inMemory = false;

  // Use in-memory MongoDB for local development if MONGODB_URI is not set
  if (!uri && NODE_ENV !== 'production') {
    console.log('Starting in-memory MongoDB server...');
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mongoMemoryServer = await MongoMemoryServer.create();
    uri = mongoMemoryServer.getUri();
    inMemory = true;
    // Write URI so the db:dump script can connect to this instance
    fs.writeFileSync(MONGO_URI_FILE, uri);
  }

  if (!uri) {
    console.error('FATAL: MONGODB_URI environment variable is not set and could not start in-memory server.');
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);
    console.log(`MongoDB Connected: ${uri.startsWith('mongodb+srv') ? 'Remote Cluster' : (inMemory ? 'In-Memory' : 'Local Instance')}`);
    if (inMemory) await seedFromFile();
  } catch (err) {
    console.error('MongoDB Connection Error:', err);
    process.exit(1);
  }
}
