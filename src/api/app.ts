import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, derivedKeyMiddleware } from './utils';
import { handleLogin, handleRegister, handleSession, handleLogout } from './controllers/auth.controller';
import { handleGetAggregates, handleGetProductTrends, handleGetOrders, handleGetOrderDetail, handleGetStats } from './controllers/order.controller';
import { handleGetInventory } from './controllers/inventory.controller';
import { handleListIntegrations, handleConnectKnuspr, handleDisconnectKnuspr, handleSyncKnuspr } from './controllers/settings.controller';
import { handleAddToCart, handleGetCart } from './controllers/cart.controller';

export const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(derivedKeyMiddleware);

app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

const auth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

app.post('/api/register', handleRegister);
app.post('/api/login', handleLogin);
app.post('/api/logout', handleLogout);
app.get('/api/session', auth, handleSession);

app.get('/api/stats', auth, handleGetStats);
app.get('/api/aggregates', auth, handleGetAggregates);
app.get('/api/orders', auth, handleGetOrders);
app.get('/api/orders/:id', auth, handleGetOrderDetail);
app.get('/api/product-trends', auth, handleGetProductTrends);
app.get('/api/inventory', auth, handleGetInventory);
app.get('/api/cart', auth, handleGetCart);
app.post('/api/cart/add', auth, handleAddToCart);

app.get('/api/settings/integrations', auth, handleListIntegrations);
app.post('/api/settings/integrations/knuspr', auth, handleConnectKnuspr);
app.delete('/api/settings/integrations/knuspr', auth, handleDisconnectKnuspr);
app.post('/api/settings/integrations/knuspr/sync', auth, handleSyncKnuspr);
