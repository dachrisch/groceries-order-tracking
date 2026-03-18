import { Request, Response } from 'express';
import Integration from '../../models/Integration';
import { encrypt } from '../../lib/crypto';
import { loginToKnuspr } from '../../lib/knuspr-auth';
import { importOrders } from '../../lib/order-importer';
// Note: utils.ts declares the global Express.Request augmentation (userId, derivedKey),
// so req.userId and req.derivedKey are typed without any casting.
import '../utils';

export async function handleListIntegrations(req: Request, res: Response) {
  const integrations = await Integration.find({ userId: req.userId }).select('provider lastSyncAt createdAt');
  res.json(integrations);
}

export async function handleConnectKnuspr(req: Request, res: Response) {
  const key = req.derivedKey;
  if (!key) return res.status(401).json({ error: 'Session key missing — please log in again' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  // Validate credentials against Knuspr before storing
  try {
    await loginToKnuspr(email, password);
  } catch (err: any) {
    return res.status(400).json({ error: `Knuspr login failed: ${err.message}` });
  }

  const encryptedCredentials = encrypt(JSON.stringify({ email, password }), key);

  await Integration.findOneAndUpdate(
    { userId: req.userId, provider: 'knuspr' },
    { encryptedCredentials, lastSyncAt: null },
    { upsert: true, new: true }
  );

  res.json({ message: 'Knuspr connected successfully' });
}

export async function handleDisconnectKnuspr(req: Request, res: Response) {
  await Integration.deleteOne({ userId: req.userId, provider: 'knuspr' });
  res.json({ message: 'Knuspr disconnected' });
}

export async function handleSyncKnuspr(req: Request, res: Response) {
  const key = req.derivedKey;
  if (!key) return res.status(401).json({ error: 'Session key missing — please log in again' });

  const integration = await Integration.findOne({ userId: req.userId, provider: 'knuspr' });
  if (!integration) return res.status(404).json({ error: 'Knuspr not connected. Go to Settings to connect.' });

  try {
    // @ts-ignore — importOrders signature will be updated in Task 6
    const result = await importOrders(req.userId, key, integration);
    await Integration.findByIdAndUpdate(integration._id, { lastSyncAt: new Date() });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
