/**
 * Dumps all MongoDB collections to dev-seed.json.
 * Uses the running in-memory backend's URI (written to /tmp/groceries-mongo-uri),
 * or MONGODB_URI env var if set.
 *
 * Usage:
 *   npm run db:dump        # while npm run dev:backend is running
 */
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { EJSON } from 'bson';
import { MONGO_URI_FILE } from '../src/lib/mongodb.js';

const DEV_SEED_FILE = path.join(process.cwd(), 'dev-seed.json');

async function dump() {
  let uri = process.env.MONGODB_URI;

  if (!uri) {
    if (!fs.existsSync(MONGO_URI_FILE)) {
      console.error('No MONGODB_URI set and no running backend found at', MONGO_URI_FILE);
      console.error('Start "npm run dev:backend" first, then run this script.');
      process.exit(1);
    }
    uri = fs.readFileSync(MONGO_URI_FILE, 'utf8').trim();
    console.log('Connecting to in-memory MongoDB from running backend...');
  } else {
    console.log('Connecting via MONGODB_URI...');
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const collections = await db.listCollections().toArray();

  const seed: Record<string, any[]> = {};

  for (const col of collections) {
    const docs = await db.collection(col.name).find({}).toArray();
    seed[col.name] = docs;
    console.log(`  Exported ${docs.length} docs from ${col.name}`);
  }

  fs.writeFileSync(DEV_SEED_FILE, EJSON.stringify(seed, { relaxed: false }, 2));
  console.log(`\nSaved to ${DEV_SEED_FILE}`);
  await mongoose.disconnect();
}

dump().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
