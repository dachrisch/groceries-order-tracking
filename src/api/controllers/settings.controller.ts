import { Request, Response } from 'express';
import Integration from '../../models/Integration';
import { encrypt } from '../../lib/crypto';
import { loginToKnuspr } from '../../lib/knuspr-auth';
import { importOrders } from '../../lib/order-importer';
import { invalidateProductGroupCache, rebuildProductGroups } from '../../lib/bot/product-groups';
import { matchRunsToOrders, tagOccasionOrders } from '../../lib/bot/order-matching';
import { detectOccasions } from '../../lib/bot/occasions';
import { discoverRecipes } from '../../lib/bot/recipes';
// Note: utils.ts declares the global Express.Request augmentation (userId, derivedKey),
// so req.userId and req.derivedKey are typed without any casting.
import '../utils';

export async function handleListIntegrations(req: Request, res: Response) {
  try {
    const integrations = await Integration.find({ userId: req.userId }).select('provider lastSyncAt createdAt');
    res.json(integrations);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleConnectKnuspr(req: Request, res: Response) {
  const key = req.derivedKey;
  if (!key) return res.status(401).json({ error: 'Session key missing — please log in again' });

  const { email, password } = req.body;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  try {
    // Validate credentials against Knuspr before storing
    await loginToKnuspr(email, password);

    const encryptedCredentials = encrypt(JSON.stringify({ email, password }), key);

    await Integration.findOneAndUpdate(
      { userId: req.userId, provider: 'knuspr' },
      { encryptedCredentials, lastSyncAt: null },
      { upsert: true, returnDocument: 'after' }
    );

    res.json({ message: 'Knuspr connected successfully' });
  } catch (err: unknown) {
    const isCredentialError = (err as Error).message?.includes('Knuspr login') || (err as Error).message?.includes('Invalid Knuspr');
    return res.status(isCredentialError ? 400 : 500).json({ error: (err as Error).message });
  }
}

export async function handleDisconnectKnuspr(req: Request, res: Response) {
  try {
    await Integration.deleteOne({ userId: req.userId, provider: 'knuspr' });
    res.json({ message: 'Knuspr disconnected' });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleSyncKnuspr(req: Request, res: Response) {
  const key = req.derivedKey;
  if (!key) return res.status(401).json({ error: 'Session key missing — please log in again' });

  const integration = await Integration.findOne({ userId: req.userId, provider: 'knuspr' });
  if (!integration) return res.status(404).json({ error: 'Knuspr not connected. Go to Settings to connect.' });

  try {
    const result = await importOrders(req.userId, key, integration);
    await Integration.findByIdAndUpdate(integration._id, { lastSyncAt: new Date() });

    // Learning runs after every sync: rebuild product groups, then match the
    // new orders against open bot runs and occasion baskets.
    invalidateProductGroupCache(req.userId);
    await rebuildProductGroups(req.userId);
    await detectOccasions(req.userId);
    await matchRunsToOrders(req.userId);
    await tagOccasionOrders(req.userId);
    // At most daily and only when groups changed; never blocks the sync result.
    void discoverRecipes(req.userId).catch((error) => console.error('recipe discovery failed:', error));

    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
}
