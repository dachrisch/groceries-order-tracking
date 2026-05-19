import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { connectDB, dumpDB } from '../lib/mongodb';
import { app } from './app';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

// Serve static files in production
const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));

// SPA Fallback: Serve index.html for all other routes
app.get('*path', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(distPath, 'index.html'));
  } else {
    res.status(404).json({ error: 'API endpoint not found' });
  }
});

// Start Server
async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();

// On Ctrl+C or process stop: dump in-memory DB to dev-seed.json so next start is pre-filled
async function shutdown() {
  await dumpDB();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
