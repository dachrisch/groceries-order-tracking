import Order from '../models/Order';
import User from '../models/User';

export function parseCurl(curl: string) {
  const headers: Record<string, string> = {};
  const hRegex = /-H\s+'([^:]+):\s*(.+?)'/g;
  let match;
  while ((match = hRegex.exec(curl)) !== null) {
    headers[match[1]] = match[2];
  }
  const bRegex = /-b\s+'([^']+)'/;
  const bMatch = curl.match(bRegex);
  if (bMatch) {
    headers['cookie'] = bMatch[1];
  }
  return headers;
}

export async function importOrders(userId: string, curl?: string) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  let headers = user.knusprCredentials?.headers ? Object.fromEntries(user.knusprCredentials.headers) : null;
  const cookie = user.knusprCredentials?.cookie;

  if (curl) {
    const newHeaders = parseCurl(curl);
    user.knusprCredentials = {
      headers: new Map(Object.entries(newHeaders)),
      cookie: newHeaders['cookie'] || '',
      lastImport: new Date()
    };
    await user.save();
    headers = newHeaders;
  }

  if (!headers) throw new Error('No credentials found. Please provide a curl command.');

  console.log(`Starting import for user ${user.name}...`);
  
  let offset = 0;
  const limit = 20;
  let importedCount = 0;
  let shouldContinue = true;

  while (shouldContinue) {
    const url = `https://www.knuspr.de/api/v3/orders/delivered?offset=${offset}&limit=${limit}`;
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      if (response.status === 401) throw new Error('Unauthorized. Please provide a new curl command.');
      throw new Error(`Failed to fetch orders: ${response.statusText}`);
    }

    const summaries = await response.json();
    if (!Array.isArray(summaries) || summaries.length === 0) break;

    for (const summary of summaries) {
      // Check if order already exists
      const existing = await Order.findOne({ userId, id: summary.id });
      if (existing) {
        // Since orders are sorted by date desc, if we find an existing one, we might stop
        // unless it's a very old order and we are doing a full backfill.
        // For simplicity, we stop here if we've found an existing order and we're not at the first page.
        if (offset > 0) {
            shouldContinue = false;
            break;
        }
        continue;
      }

      // Fetch detail
      const detailUrl = `https://www.knuspr.de/api/v3/orders/${summary.id}`;
      const detailResponse = await fetch(detailUrl, { headers });
      if (!detailResponse.ok) continue;

      const detail = await detailResponse.json();
      detail.userId = userId;
      detail.orderTimeDate = new Date(detail.orderTime);

      await Order.create(detail);
      importedCount++;
    }

    if (summaries.length < limit) break;
    offset += limit;
  }

  return { importedCount };
}
