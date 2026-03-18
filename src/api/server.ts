import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { connectDB } from '../lib/mongodb';
import { JWT_SECRET } from './utils';
import { handleLogin, handleRegister, handleSession, handleLogout } from './controllers/auth.controller';
import { handleImport, handleGetAggregates, handleGetProductTrends } from './controllers/order.controller';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

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

app.post('/api/import', auth, handleImport);
app.get('/api/aggregates', auth, handleGetAggregates);
app.get('/api/product-trends', auth, handleGetProductTrends);

// Start Server
async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start();
