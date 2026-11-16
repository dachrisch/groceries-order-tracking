import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { z } from 'zod';
import Integration, { IntegrationProvider } from '../../models/Integration';
import PurchaseSession from '../../models/PurchaseSession';
import { decrypt, encrypt } from '../../lib/crypto';
import { formatZodError } from '../utils';
import { EasyShopperClient, type EasyShopperCredentials, type EasyShopperSession } from '../../lib/easyshopper/client';
import { isOpencodeConfigured } from '../../lib/opencode-client';
import { getExtractJob, startExtractJob } from '../../lib/easyshopper/extract-jobs';
import { planShoppingList, rerankWithHistory } from '../../lib/easyshopper/list';
import { toCandidate, type MatchCandidate } from '../../lib/easyshopper/match';
import { summarizePurchases } from '../../lib/easyshopper/insights';
import '../utils';

/** Store the app falls back to when the user has not picked one (BuildConfig default). */
const DEFAULT_STORE_GUID = process.env.EASYSHOPPER_STORE_GUID ?? '682ef075-b1c1-472a-9924-d25748d95ee7';

interface StoredAccount extends EasyShopperCredentials {
  uniqueDeviceId: string;
  userGuid?: string;
  storeGuid?: string;
}

const purchaseItemSchema = z.object({
  brand: z.string().nullable().optional(),
  name: z.string().min(1),
  quantity: z.number().nullable().optional(),
  unitPrice: z.number().nullable().optional(),
  lineTotal: z.number().nullable().optional(),
  isCredit: z.boolean().optional(),
  raw: z.string().optional(),
});

const purchaseSessionSchema = z.object({
  key: z.string().min(1).optional(),
  displayWhen: z.string().optional(),
  purchasedAt: z.string().min(1),
  store: z.string().min(1),
  type: z.string().optional(),
  paymentMode: z.string().nullable().optional(),
  receiptBarcode: z.string().nullable().optional(),
  itemCount: z.number().nullable().optional(),
  total: z.number(),
  reconciled: z.boolean().optional(),
  difference: z.number().optional(),
  items: z.array(purchaseItemSchema).default([]),
});

const importSchema = z.object({
  sessions: z.array(purchaseSessionSchema).min(1),
});

function sessionKey(session: z.infer<typeof purchaseSessionSchema>): string {
  if (session.key) return session.key;
  return `${session.purchasedAt}|${session.store}|${session.total.toFixed(2)}`;
}

/** POST /api/easyshopper/import-purchases — sidecar upload, idempotent per session key. */
export async function handleImportPurchases(req: Request, res: Response) {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: formatZodError(parsed.error) });

  const operations = parsed.data.sessions.map((session) => {
    const purchasedAt = new Date(session.purchasedAt);
    return {
      updateOne: {
        filter: { userId: req.userId, key: sessionKey(session) },
        update: {
          $set: {
            source: 'easyshopper',
            purchasedAt: Number.isNaN(purchasedAt.getTime()) ? new Date() : purchasedAt,
            store: session.store,
            type: session.type ?? 'CART',
            paymentMode: session.paymentMode ?? null,
            receiptBarcode: session.receiptBarcode ?? null,
            unitCount: session.itemCount ?? null,
            total: session.total,
            reconciled: session.reconciled ?? true,
            difference: session.difference ?? 0,
            items: session.items.map((item) => ({
              brand: item.brand ?? null,
              name: item.name,
              quantity: item.quantity ?? 1,
              unitPrice: item.unitPrice ?? null,
              lineTotal: item.lineTotal ?? null,
              isCredit: item.isCredit ?? (item.lineTotal ?? 0) < 0,
              raw: item.raw ?? '',
            })),
          },
        },
        upsert: true,
      },
    };
  });

  try {
    const result = await PurchaseSession.bulkWrite(operations, { ordered: false });
    // The sidecar has delivered: clear the UI's pending request.
    await Integration.updateOne(
      { userId: req.userId, provider: IntegrationProvider.EASySHOPPER },
      { $set: { syncRequestedAt: null, lastSyncAt: new Date() } }
    );
    res.json({
      received: parsed.data.sessions.length,
      inserted: result.upsertedCount ?? 0,
      updated: result.modifiedCount ?? 0,
    });
  } catch (err: unknown) {
    console.error('EASY Shopper import failed:', err);
    res.status(500).json({ error: 'failed to import purchases' });
  }
}

/** GET /api/easyshopper/purchases — stored sessions plus a lightweight summary. */
export async function handleGetPurchases(req: Request, res: Response) {
  try {
    const sessions = await PurchaseSession.find({ userId: req.userId }).sort({ purchasedAt: -1 }).lean();
    const stores = new Map<string, { store: string; visits: number; total: number }>();
    for (const session of sessions) {
      const entry = stores.get(session.store) ?? { store: session.store, visits: 0, total: 0 };
      entry.visits += 1;
      entry.total = Number((entry.total + session.total).toFixed(2));
      stores.set(session.store, entry);
    }
    res.json({ sessions, stores: [...stores.values()] });
  } catch (err: unknown) {
    console.error('EASY Shopper purchases read failed:', err);
    res.status(500).json({ error: 'failed to read purchases' });
  }
}

/** GET /api/easyshopper/insights — what was actually bought, where, and for how much. */
export async function handleGetInsights(req: Request, res: Response) {
  try {
    const sessions = await PurchaseSession.find({ userId: req.userId }).sort({ purchasedAt: 1 }).lean();
    res.json(
      summarizePurchases(
        sessions.map((session) => ({
          purchasedAt: session.purchasedAt,
          store: session.store,
          total: session.total,
          items: session.items.map((item) => ({
            brand: item.brand ?? null,
            name: item.name,
            quantity: item.quantity ?? 1,
            unitPrice: item.unitPrice ?? null,
            lineTotal: item.lineTotal ?? null,
            isCredit: item.isCredit ?? false,
          })),
        }))
      )
    );
  } catch (err: unknown) {
    console.error('EASY Shopper insights failed:', err);
    res.status(500).json({ error: 'failed to build purchase insights' });
  }
}

/** Load or create the integration's own anonymous device account. */
export async function ensureSession(
  userId: string,
  key: Buffer,
  preferredStoreGuid?: string
): Promise<{ client: EasyShopperClient; session: EasyShopperSession; storeGuid: string }> {
  const client = new EasyShopperClient();
  const integration = await Integration.findOne({
    userId,
    provider: IntegrationProvider.EASySHOPPER,
  });

  const storeGuid = preferredStoreGuid ?? DEFAULT_STORE_GUID;

  let account: StoredAccount;
  if (integration?.encryptedCredentials) {
    account = JSON.parse(decrypt(integration.encryptedCredentials, key)) as StoredAccount;
  } else {
    const credentials = await client.signup(storeGuid);
    account = { ...credentials, uniqueDeviceId: randomUUID(), storeGuid };
    await Integration.findOneAndUpdate(
      { userId, provider: IntegrationProvider.EASySHOPPER },
      {
        encryptedCredentials: encrypt(JSON.stringify(account), key),
        lastSyncAt: new Date(),
      },
      { upsert: true, returnDocument: 'after' }
    );
  }

  const session = await client.login(account, account.uniqueDeviceId);
  return { client, session, storeGuid: preferredStoreGuid ?? session.storeGuid ?? storeGuid };
}

const planSchema = z.object({
  // Cap the typed path to what a photo may yield (60 lines, 80-char lines in
  // `extract.ts`, so 200 here is generous): a thousand lines would become a thousand
  // store searches.
  lines: z.array(z.string().min(1).max(200)).min(1).max(60),
  storeGuid: z.string().optional(),
  attributes: z.array(z.string()).optional(),
  // `false` forces the instant rules plan, e.g. when opencode is slow or the shopper
  // does not want a model call at all.
  useModel: z.boolean().optional(),
});

/** Trim the typed lines; the photo is a separate, asynchronous step. */
function linesFromRequest(body: z.infer<typeof planSchema>): string[] {
  return body.lines.map((line) => line.trim()).filter(Boolean);
}

const extractSchema = z.object({
  // The real ceiling is express.json({limit:'2mb'}) in app.ts; keep the schema below it
  // so an oversized photo fails here with a readable message instead of a bare 413.
  imageBase64: z.string().min(64).max(2_000_000),
});

/** POST /api/easyshopper/list/extract — opencode reads the photo; returns a job id. */
export async function handleExtractList(req: Request, res: Response) {
  const parsed = extractSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: formatZodError(parsed.error) });
  if (!isOpencodeConfigured()) {
    return res.status(503).json({ error: 'reading a photo needs opencode (OPENCODE_BASE_URL / OPENCODE_API_KEY)' });
  }

  const job = startExtractJob(req.userId, parsed.data.imageBase64);
  if (!job) {
    // One read per user, so a second chain cannot burn a second model call.
    return res.status(429).json({ error: 'a photo is already being read — wait for it to finish' });
  }
  res.status(202).json({ jobId: job.id });
}

/** GET /api/easyshopper/list/extract/:id — poll one photo read. */
export async function handleExtractStatus(req: Request, res: Response) {
  const { id } = req.params;
  const job = typeof id === 'string' ? getExtractJob(req.userId, id) : null;
  if (!job) return res.status(404).json({ error: 'that photo read was lost — read the photo again' });
  res.json({
    status: job.status,
    // Nothing is known before the answer: report `null`, not "no lines" and not "free".
    lines: job.lines ?? null,
    ticked: job.ticked ?? 0,
    model: job.model ?? null,
    paid: job.paid ?? null,
    error: job.error ?? null,
  });
}

/** POST /api/easyshopper/list/plan — search + (opencode) match, no writes. */
export async function handlePlanList(req: Request, res: Response) {
  const key = req.derivedKey;
  if (!key) return res.status(401).json({ error: 'Session key missing — please log in again' });
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: formatZodError(parsed.error) });

  const lines = linesFromRequest(parsed.data);
  // Typed lines are thin: a body of nothing but blanks must still be refused.
  if (lines.length === 0) return res.status(400).json({ error: 'no lines to plan' });

  try {
    const { client, session, storeGuid } = await ensureSession(req.userId, key, parsed.data.storeGuid);
    const plan = await planShoppingList(
      client,
      session,
      {
        lines,
        storeGuid,
        attributes: parsed.data.attributes,
        extraCandidates: await recentlyBoughtCandidates(req.userId),
      },
      { useModel: parsed.data.useModel }
    );
    res.json(plan);
  } catch (err: unknown) {
    console.error('EASY Shopper plan failed:', err);
    const message = err instanceof Error ? err.message : 'planning failed';
    res.status(502).json({ error: message });
  }
}

/** Products the user bought recently, as extra match candidates. */
async function recentlyBoughtCandidates(userId: string): Promise<MatchCandidate[]> {
  const sessions = await PurchaseSession.find({ userId }).sort({ purchasedAt: -1 }).limit(6).lean();
  const byName = new Map<string, MatchCandidate>();
  for (const session of sessions) {
    for (const item of session.items) {
      const name = item.name;
      if (!name) continue;
      byName.set(`${item.brand ?? ''}|${name}`, {
        name,
        brand: item.brand ?? null,
        price: item.unitPrice ?? null,
        raw: { name, brand: item.brand ?? null },
      });
    }
  }
  return [...byName.values()];
}

const createSchema = planSchema.extend({
  createShareLink: z.boolean().optional(),
});

/** POST /api/easyshopper/list/create — write the plan into the account's list. */
export async function handleCreateList(req: Request, res: Response) {
  const key = req.derivedKey;
  if (!key) return res.status(401).json({ error: 'Session key missing — please log in again' });
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: formatZodError(parsed.error) });

  const lines = linesFromRequest(parsed.data);
  // Typed lines are thin: a body of nothing but blanks must still be refused.
  if (lines.length === 0) return res.status(400).json({ error: 'no lines to plan' });

  try {
    const { client, session, storeGuid } = await ensureSession(req.userId, key, parsed.data.storeGuid);
    const bought = await recentlyBoughtCandidates(req.userId);
    // The shopper's preview is advisory: this handler plans again, so a re-roll may pick
    // differently. Accepting the client's own plan back is a follow-up.
    const plan = rerankWithHistory(
      await planShoppingList(
        client,
        session,
        {
          lines,
          storeGuid,
          attributes: parsed.data.attributes,
          extraCandidates: bought,
        },
        { useModel: parsed.data.useModel }
      ),
      bought
    );

    let added = 0;
    for (const entry of plan.lines) {
      const candidate = entry.match.candidate;
      const product =
        entry.action === 'product' && candidate?.raw
          ? ((candidate.raw.product as Record<string, unknown> | undefined) ?? candidate.raw)
          : undefined;
      await client.upsertItem(session.token, storeGuid, {
        amount: entry.line.quantity,
        name: candidate?.name ?? entry.line.text,
        brand: candidate?.brand ?? null,
        unit: typeof product?.unit === 'string' ? product.unit : undefined,
        product,
      });
      added += 1;
    }

    let shareLink: string | null = null;
    if (parsed.data.createShareLink !== false) {
      const lists = await client.listShoppingLists(session.token);
      const target = findListForStore(lists, storeGuid);
      if (target) shareLink = await client.createShareLink(session.token, target);
    }

    res.json({ added, plan, shareLink });
  } catch (err: unknown) {
    console.error('EASY Shopper list create failed:', err);
    const message = err instanceof Error ? err.message : 'list creation failed';
    res.status(502).json({ error: message });
  }
}

/** POST /api/easyshopper/sync/request — ask the sidecar to read the phone. */
export async function handleRequestSync(req: Request, res: Response) {
  try {
    const requestedAt = new Date();
    await Integration.findOneAndUpdate(
      { userId: req.userId, provider: IntegrationProvider.EASySHOPPER },
      { $set: { syncRequestedAt: requestedAt } },
      { upsert: true }
    );
    res.json({ requestedAt: requestedAt.toISOString() });
  } catch (err: unknown) {
    console.error('EASY Shopper sync request failed:', err);
    res.status(500).json({ error: 'failed to request a sync' });
  }
}

/** GET /api/easyshopper/sync/status — what the sidecar and the UI both need. */
export async function handleSyncStatus(req: Request, res: Response) {
  try {
    const [integration, latest, sessions] = await Promise.all([
      Integration.findOne({ userId: req.userId, provider: IntegrationProvider.EASySHOPPER }).lean(),
      PurchaseSession.findOne({ userId: req.userId }).sort({ purchasedAt: -1 }).lean(),
      PurchaseSession.countDocuments({ userId: req.userId }),
    ]);
    res.json({
      requestedAt: integration?.syncRequestedAt ?? null,
      lastImportAt: integration?.lastSyncAt ?? null,
      lastPurchaseAt: latest?.purchasedAt ?? null,
      sessions,
    });
  } catch (err: unknown) {
    console.error('EASY Shopper sync status failed:', err);
    res.status(500).json({ error: 'failed to read sync status' });
  }
}

/**
 * GET /api/easyshopper/share-code — what the phone scans.
 *
 * The app's "Share Your Shopping List" screen shows an Aztec barcode whose payload is
 * the owner's `userGuid`; the follower's scanner then calls
 * `POST /v4/shoppingList/follow {userGuid}`. There is no link and no expiry on this
 * path, so it is the one to use.
 */
export async function handleShareCode(req: Request, res: Response) {
  const key = req.derivedKey;
  if (!key) return res.status(401).json({ error: 'Session key missing — please log in again' });
  try {
    const { session, storeGuid } = await ensureSession(req.userId, key);
    res.json({ userGuid: session.userGuid, storeGuid, format: 'aztec' });
  } catch (err: unknown) {
    console.error('EASY Shopper share code failed:', err);
    res.status(502).json({ error: err instanceof Error ? err.message : 'share code failed' });
  }
}

/** Share links live 24 h, so one is minted on demand rather than stored. */
const SHARE_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** POST /api/easyshopper/list/share — (re)mint the invite link for the active list. */
export async function handleShareList(req: Request, res: Response) {
  const key = req.derivedKey;
  if (!key) return res.status(401).json({ error: 'Session key missing — please log in again' });
  const storeGuid = typeof req.body?.storeGuid === 'string' ? req.body.storeGuid : undefined;

  try {
    const { client, session, storeGuid: resolvedStore } = await ensureSession(req.userId, key, storeGuid);
    const lists = await client.listShoppingLists(session.token);
    const target = findListForStore(lists, resolvedStore);
    if (!target) return res.status(409).json({ error: 'this account has no shopping list to share' });

    const shareLink = await client.createShareLink(session.token, target);
    if (!shareLink) return res.status(502).json({ error: 'the API returned no invite link' });
    res.json({ shareLink, expiresAt: new Date(Date.now() + SHARE_LINK_TTL_MS).toISOString() });
  } catch (err: unknown) {
    console.error('EASY Shopper share failed:', err);
    const message = err instanceof Error ? err.message : 'share failed';
    res.status(502).json({ error: message });
  }
}

/** Pick the list guid for a store, tolerating the naming the API happens to use. */
export function findListForStore(lists: Record<string, unknown>[], storeGuid: string): string | null {
  const guidOf = (list: Record<string, unknown>): string | null => {
    const candidate = (list.shoppingListGuid ?? list.guid ?? list.id) as string | undefined;
    return candidate ?? null;
  };
  const forStore = lists.find((list) => {
    const listStore = (list.storeGuid ?? list.store) as string | undefined;
    return typeof listStore === 'string' && listStore === storeGuid;
  });
  return guidOf(forStore ?? lists[0] ?? {}) ?? null;
}

export { toCandidate };
