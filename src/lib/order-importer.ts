import Order from '../models/Order';
import { decrypt } from './crypto';
import { loginToKnuspr } from './knuspr-auth';

const KNUSPR_API_BASE = 'https://www.knuspr.de';

async function fetchWithSession(url: string, session: string) {
  return fetch(url, {
    headers: {
      'Cookie': `PHPSESSION_de-production=${session}`,
      'x-origin': 'WEB',
    },
  });
}

interface KnusprCategory {
  id: number;
  name: string;
  slug: string;
  level: number;
}

export async function importOrders(
  userId: string,
  derivedKey: Buffer,
  integration: { encryptedCredentials: string }
): Promise<{ importedCount: number }> {
  // Decrypt stored Knuspr credentials
  let knusprEmail: string;
  let knusprPassword: string;
  try {
    const creds = JSON.parse(decrypt(integration.encryptedCredentials, derivedKey));
    knusprEmail = creds.email;
    knusprPassword = creds.password;
  } catch {
    throw new Error('Failed to decrypt Knuspr credentials — please reconnect in Settings');
  }

  // Get fresh Knuspr session
  let { session } = await loginToKnuspr(knusprEmail, knusprPassword);
  const categoriesCache = new Map<number, KnusprCategory[]>();

  async function getCategories(productId: number, session: string): Promise<KnusprCategory[]> {
    if (categoriesCache.has(productId)) return categoriesCache.get(productId)!;
    try {
      const res = await fetchWithSession(`${KNUSPR_API_BASE}/api/v1/products/${productId}/categories`, session);
      if (res.ok) {
        const data = await res.json();
        const categories = data.categories || [];
        categoriesCache.set(productId, categories);
        return categories;
      }
    } catch (e) {
      console.error(`Failed to fetch categories for product ${productId}:`, e);
    }
    return [];
  }

  console.log(`Starting Knuspr import for userId ${userId}...`);


  let offset = 0;
  const limit = 20;
  let importedCount = 0;
  let shouldContinue = true;

  while (shouldContinue) {
    const url = `${KNUSPR_API_BASE}/api/v3/orders/delivered?offset=${offset}&limit=${limit}`;
    let response = await fetchWithSession(url, session);

    // Auto-refresh session once on 401
    if (response.status === 401) {
      ({ session } = await loginToKnuspr(knusprEmail, knusprPassword));
      response = await fetchWithSession(url, session);
    }

    if (!response.ok) {
      throw new Error(`Knuspr API error: ${response.status} ${response.statusText}`);
    }

    const summaries = await response.json();
    if (!Array.isArray(summaries) || summaries.length === 0) break;

    for (const summary of summaries) {
      const existing = await Order.findOne({ userId, id: summary.id });
      if (existing) {
        // Early-stop assumes Knuspr returns orders newest-first. If an existing order is
        // found on page 2+ we assume all subsequent pages are also already imported.
        // On page 0 we continue processing in case older orders on the same page are new.
        if (offset > 0) {
          shouldContinue = false;
          break;
        }
        continue;
      }

      const detailUrl = `${KNUSPR_API_BASE}/api/v3/orders/${summary.id}`;
      let detailRes = await fetchWithSession(detailUrl, session);
      if (detailRes.status === 401) {
        ({ session } = await loginToKnuspr(knusprEmail, knusprPassword));
        detailRes = await fetchWithSession(detailUrl, session);
      }
      if (!detailRes.ok) continue;

      const { _id: _ignored, ...detail } = await detailRes.json();
      detail.userId = userId;
      detail.orderTimeDate = new Date(detail.orderTime);

      // Fetch categories for each item in the order
      if (Array.isArray(detail.items)) {
        for (const item of detail.items) {
          if (item.id) {
            item.categories = await getCategories(item.id, session);
          }
        }
      }

      // Use upsert to prevent duplicate-key errors on concurrent syncs
      const upsertResult = await Order.findOneAndUpdate(
        { userId, id: detail.id },
        { $setOnInsert: detail },
        { upsert: true, returnDocument: 'before' }
      );
      if (!upsertResult) importedCount++; // null means it was inserted (not found before)
    }

    if (summaries.length < limit) break;
    offset += limit;
  }

  return { importedCount };
}
