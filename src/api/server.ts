import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { connectDB } from '../lib/mongodb';
import { app } from './app';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

// Serve static files in production
const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));

// SPA Fallback: Serve index.html for all other routes
app.get('*', (req, res) => {
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
