import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { connectDB } from '../lib/mongodb';
import { JWT_SECRET, derivedKeyMiddleware } from './utils';
import { handleLogin, handleRegister, handleSession, handleLogout } from './controllers/auth.controller';
import { handleGetAggregates, handleGetProductTrends, handleGetOrders, handleGetOrderDetail, handleGetStats } from './controllers/order.controller';
import { handleListIntegrations, handleConnectKnuspr, handleDisconnectKnuspr, handleSyncKnuspr } from './controllers/settings.controller';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(derivedKeyMiddleware);

// Healthcheck endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Auth Middleware
const auth = (req: any, res: any, next: any) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// Routes
app.post('/api/register', handleRegister);
app.post('/api/login', handleLogin);
app.post('/api/logout', handleLogout);
app.get('/api/session', auth, handleSession);

app.get('/api/stats', auth, handleGetStats);
app.get('/api/aggregates', auth, handleGetAggregates);
app.get('/api/orders', auth, handleGetOrders);
app.get('/api/orders/:id', auth, handleGetOrderDetail);
app.get('/api/product-trends', auth, handleGetProductTrends);

// Settings routes (all require auth):
app.get('/api/settings/integrations', auth, handleListIntegrations);
app.post('/api/settings/integrations/knuspr', auth, handleConnectKnuspr);
app.delete('/api/settings/integrations/knuspr', auth, handleDisconnectKnuspr);
app.post('/api/settings/integrations/knuspr/sync', auth, handleSyncKnuspr);

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
