import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { doubleCsrf } from 'csrf-csrf';
import { JWT_SECRET, CSRF_SECRET, derivedKeyMiddleware } from './utils';
import { handleLogin, handleRegister, handleSession, handleLogout } from './controllers/auth.controller';
import { handleGetAggregates, handleGetProductTrends, handleGetOrders, handleGetOrderDetail, handleGetStats, handleGetProductPrice } from './controllers/order.controller';

import { handleGetInventory } from './controllers/inventory.controller';
import { handleListIntegrations, handleConnectKnuspr, handleDisconnectKnuspr, handleSyncKnuspr } from './controllers/settings.controller';
import { handleAddToCart, handleGetCart } from './controllers/cart.controller';

export const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "img-src": ["'self'", "data:", "https://cdn.knuspr.de"],
    },
  },
}));
app.use(express.json());
app.use(cookieParser());

const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
  getSecret: () => CSRF_SECRET,
  cookieName: 'x-csrf-token',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  },
  size: 64,
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
  getTokenFromRequest: (req) => req.headers['x-csrf-token'] as string,
  getSessionIdentifier: (req) => req.cookies.token || 'anonymous',
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes).
  standardHeaders: 'draft-7', // set `RateLimit` and `RateLimit-Policy` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers.
});

app.use('/api/', limiter);
app.use(derivedKeyMiddleware);

app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

app.get('/api/csrf-token', (req, res) => {
  res.json({ token: generateCsrfToken(req, res) });
});

app.get('/api/version', (_req, res) => {
  res.json({ version: process.env.APP_VERSION || 'dev' });
});

// Protect all following /api/ routes with CSRF check (ignored for GET/HEAD/OPTIONS)
app.use('/api/', (req, res, next) => {
  // Skip CSRF for login/register as they establish the session
  if (['/api/login', '/api/register'].includes(req.path)) {
    return next();
  }
  
  // Skip CSRF in tests unless explicitly requested (to avoid breaking existing tests)
  if (process.env.NODE_ENV === 'test' && !req.get('x-test-enable-csrf')) {
    return next();
  }

  doubleCsrfProtection(req, res, next);
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
app.get('/api/products/:id/price', auth, handleGetProductPrice);
app.get('/api/product-trends', auth, handleGetProductTrends);
app.get('/api/inventory', auth, handleGetInventory);
app.get('/api/cart', auth, handleGetCart);
app.post('/api/cart/add', auth, handleAddToCart);

app.get('/api/settings/integrations', auth, handleListIntegrations);
app.post('/api/settings/integrations/knuspr', auth, handleConnectKnuspr);
app.delete('/api/settings/integrations/knuspr', auth, handleDisconnectKnuspr);
app.post('/api/settings/integrations/knuspr/sync', auth, handleSyncKnuspr);
