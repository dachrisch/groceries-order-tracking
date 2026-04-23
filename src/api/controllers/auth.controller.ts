import { Request, Response } from 'express';
import User from '../../models/User';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, formatZodError } from '../utils';
import { z } from 'zod';
import { deriveKey } from '../../lib/crypto';
import Integration, { IntegrationProvider } from '../../models/Integration';
import { importOrders } from '../../lib/order-importer';

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

export async function handleRegister(req: Request, res: Response) {
  const result = registerSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: formatZodError(result.error) });
  }

  const { name, email, password } = result.data;
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(400).json({ error: 'User already exists' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await User.create({ name, email, password: hashedPassword });
  res.status(201).json({ message: 'User created', userId: user._id });
}

export async function handleLogin(req: Request, res: Response) {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: formatZodError(result.error) });
  }

  const { email, password } = result.data;
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { path: '/', httpOnly: true, maxAge: 604800000, sameSite: 'lax' });

  const key = deriveKey(email, password);
  res.cookie('dkey', key.toString('base64'), { path: '/', httpOnly: true, maxAge: 604800000, sameSite: 'lax' });

  // Trigger background sync if needed (atomic lock via findOneAndUpdate)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  Integration.findOneAndUpdate(
    {
      userId: user._id,
      provider: IntegrationProvider.KNUSPR,
      $or: [
        { lastSyncAt: { $exists: false } },
        { lastSyncAt: { $lt: oneHourAgo } }
      ]
    },
    { $set: { lastSyncAt: new Date() } },
    { returnDocument: 'after' }
  ).then(async (integration) => {
    if (integration) {
      console.log(`Triggering background sync for user ${user._id}`);
      try {
        await importOrders(user._id.toString(), key, integration);
        console.log(`Background sync completed for user ${user._id}`);
      } catch (err) {
        console.error(`Background sync error for user ${user._id}:`, err);
      }
    }
  }).catch((err) => {
    console.error(`Error checking integration for sync:`, err);
  });

  res.json({ message: 'Logged in', user: { name: user.name, email: user.email } });
}

export async function handleSession(req: Request, res: Response) {
  const userId = req.userId;
  const user = await User.findById(userId).select('-password').lean();
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json(user);
}

export async function handleLogout(req: Request, res: Response) {
  res.clearCookie('token', { path: '/', httpOnly: true, sameSite: 'lax' });
  res.clearCookie('dkey', { path: '/', httpOnly: true, sameSite: 'lax' });
  res.json({ message: 'Logged out' });
}
