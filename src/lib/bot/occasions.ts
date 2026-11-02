import mongoose from 'mongoose';
import Order from '../../models/Order';
import Occasion from '../../models/Occasion';
import BotRun from '../../models/BotRun';
import { getKnusprSession } from '../knuspr-auth';
import { addItems, cartQuantityByProduct, checkCart, fetchPrices, getCart, normalizeCart } from '../knuspr-cart';
import { getOpencodeConfig, runPrompt } from '../opencode-client';
import { getWeeklyConsumption, type ConsumptionItem } from './consumption';
import { getProductGroupMap, parseSize, type BuiltGroup } from './product-groups';
import {
  chooseVariant,
  getBotSettings,
  planWeeklyFill,
  type FillResult,
  type PlannedItem,
} from './fill';
import { tagOccasionOrders } from './order-matching';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 182;
const MIN_OCCURRENCES = 2;
const MIN_LIFT = 1.2;
const MAX_ITEMS_PER_BASKET = 10;

export interface BasketItem {
  groupKey: string;
  productId: number;
  name: string;
  units: number;
  amount: number;
  packSize: number;
}

export interface Basket {
  orderId: number;
  date: Date;
  items: Map<string, BasketItem>;
}

export interface DetectedOccasion {
  key: string;
  name: string;
  aliases: string[];
  items: Array<{
    productId: number;
    name: string;
    groupKey: string;
    qtyPerServing: number;
    packSize: number;
    core: boolean;
  }>;
  basisServings: number;
  occurrences: number;
  lastSeen: Date;
  sourceOrders: Array<{ orderId: number; productIds: number[] }>;
}

function basketKey(items: Iterable<string>): string {
  return [...items].sort().join('|');
}

function combinations<T>(values: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (values.length < size) return [];
  const result: T[][] = [];
  for (let index = 0; index <= values.length - size; index++) {
    for (const rest of combinations(values.slice(index + 1), size - 1)) {
      result.push([values[index], ...rest]);
    }
  }
  return result;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Candidate baskets: items not explained by the weekly model, or way above normal quantity. */
export function buildCandidateBaskets(
  orders: Array<{ id: number; orderTimeDate: Date; items: Array<{ id: number; name: string; amount?: number; textualAmount?: string }> }>,
  groupByProduct: Map<number, BuiltGroup>,
  regularByGroup: Map<string, ConsumptionItem>
): Basket[] {
  const baskets: Basket[] = [];

  for (const order of orders) {
    const items = new Map<string, BasketItem>();

    for (const item of order.items ?? []) {
      const group = groupByProduct.get(item.id);
      if (!group) continue;

      const regular = regularByGroup.get(group.key);
      const amount = Math.max(1, item.amount ?? 1);
      const isCandidate = !regular || amount > regular.modeAmount * 2;
      if (!isCandidate) continue;

      const packSize = parseSize(item.textualAmount)?.value ?? 1;
      items.set(group.key, {
        groupKey: group.key,
        productId: item.id,
        name: item.name,
        units: amount * packSize,
        amount,
        packSize,
      });
    }

    if (items.size >= 2) {
      baskets.push({ orderId: order.id, date: new Date(order.orderTimeDate), items });
    }
  }

  return baskets;
}

interface Cluster {
  keys: Set<string>;
  occurrences: Basket[];
}

/** Find recurring product sets across candidate baskets. */
export function findClusters(baskets: Basket[]): Cluster[] {
  if (baskets.length < MIN_OCCURRENCES) return [];

  const itemSupport = new Map<string, number>();
  for (const basket of baskets) {
    for (const key of basket.items.keys()) {
      itemSupport.set(key, (itemSupport.get(key) ?? 0) + 1);
    }
  }

  const setSupport = new Map<string, { keys: string[]; support: number }>();
  for (const basket of baskets) {
    const keys = [...basket.items.keys()].slice(0, MAX_ITEMS_PER_BASKET);
    const maxSize = Math.min(4, keys.length);
    for (let size = 2; size <= maxSize; size++) {
      for (const combination of combinations(keys, size)) {
        const key = basketKey(combination);
        const entry = setSupport.get(key) ?? { keys: combination, support: 0 };
        entry.support++;
        setSupport.set(key, entry);
      }
    }
  }

  const total = baskets.length;
  const frequent = [...setSupport.values()]
    .filter((entry) => entry.support >= MIN_OCCURRENCES)
    .filter((entry) => {
      const expected = entry.keys.reduce(
        (product, key) => product * ((itemSupport.get(key) ?? 0) / total),
        1
      );
      if (expected === 0) return false;
      const lift = entry.support / total / expected;
      return lift >= MIN_LIFT;
    });

  // Keep maximal sets: a subset with the same (or lower) support adds nothing.
  frequent.sort((a, b) => b.keys.length - a.keys.length || b.support - a.support);
  const maximal: Array<{ keys: string[]; support: number }> = [];
  for (const candidate of frequent) {
    const redundant = maximal.some(
      (kept) =>
        candidate.keys.every((key) => kept.keys.includes(key)) &&
        kept.support >= candidate.support
    );
    if (!redundant) maximal.push(candidate);
  }

  // Merge overlapping clusters (e.g. two pizza variants).
  const merged: Array<Set<string>> = maximal.map((entry) => new Set(entry.keys));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        if (jaccard(merged[i], merged[j]) >= 0.5) {
          for (const key of merged[j]) merged[i].add(key);
          merged.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  return merged
    .map((keys) => ({
      keys,
      occurrences: baskets.filter((basket) => {
        let hits = 0;
        for (const key of keys) if (basket.items.has(key)) hits++;
        return hits / keys.size >= 0.6;
      }),
    }))
    .filter((cluster) => cluster.occurrences.length >= MIN_OCCURRENCES);
}

function fallbackName(items: Array<{ name: string }>): string {
  const names = items.slice(0, 2).map((item) => item.name.split(' ')[0]);
  return names.length > 0 ? `${names.join(' + ')} night` : 'Occasion';
}

interface LlmOccasion {
  name?: string;
  aliases?: unknown;
  estimatedServings?: unknown;
  coreItems?: unknown;
  optionalItems?: unknown;
}

async function nameClusterWithLlm(
  items: Array<{ productId: number; name: string; quantity: number }>,
  useLLM: boolean
): Promise<{ name: string; aliases: string[]; servings: number; coreIds: Set<number> } | null> {
  if (!useLLM || !getOpencodeConfig()) return null;

  const prompt = [
    'You name a recurring grocery basket. Respond with only JSON, no prose.',
    'Shape: {"name":string,"aliases":string[],"estimatedServings":number,"coreItems":number[],"optionalItems":number[]}',
    'Use the product IDs in coreItems/optionalItems. estimatedServings is how many people these quantities fed.',
    JSON.stringify({ items }),
  ].join('\n');

  try {
    const response = await runPrompt<LlmOccasion>(prompt, { timeoutMs: 60_000 });
    const name = typeof response.name === 'string' ? response.name.trim() : '';
    if (!name) return null;
    const aliases = Array.isArray(response.aliases)
      ? response.aliases.filter((alias): alias is string => typeof alias === 'string')
      : [];
    const servings = Number(response.estimatedServings);
    const coreIds = new Set<number>(
      Array.isArray(response.coreItems)
        ? response.coreItems.map(Number).filter((id) => Number.isFinite(id))
        : items.map((item) => item.productId)
    );
    return {
      name,
      aliases,
      servings: Number.isFinite(servings) && servings > 0 && servings <= 20 ? Math.round(servings) : 4,
      coreIds: coreIds.size > 0 ? coreIds : new Set(items.map((item) => item.productId)),
    };
  } catch (error) {
    console.error('opencode occasion naming failed:', error);
    return null;
  }
}

/**
 * Learn occasions from order history: candidate baskets → co-occurrence
 * clusters → opencode names/servings. Stores one Occasion per cluster.
 */
export async function detectOccasions(
  userId: string,
  options: { useLLM?: boolean } = {}
): Promise<DetectedOccasion[]> {
  const settings = await getBotSettings(userId);
  const useLLM = options.useLLM ?? settings.opencodeEnabled;

  const { items: regularItems } = await getWeeklyConsumption(userId);
  const regularByGroup = new Map(regularItems.map((item) => [item.groupKey, item]));

  const orders = await Order.find({
    userId,
    orderTimeDate: { $gte: new Date(Date.now() - WINDOW_DAYS * DAY_MS) },
  })
    .sort({ orderTimeDate: 1 })
    .select('id orderTimeDate items')
    .lean();

  const groupByProduct = await getProductGroupMap(userId);
  const baskets = buildCandidateBaskets(
    orders.map((order) => ({
      id: order.id,
      orderTimeDate: new Date(order.orderTimeDate),
      items: order.items ?? [],
    })),
    groupByProduct,
    regularByGroup
  );
  const clusters = findClusters(baskets);

  const detected: DetectedOccasion[] = [];

  for (const cluster of clusters) {
    const itemStats = new Map<string, {
      productIds: Map<number, number>;
      names: Map<number, string>;
      units: number;
      packSize: number;
    }>();

    for (const basket of cluster.occurrences) {
      for (const key of cluster.keys) {
        const basketItem = basket.items.get(key);
        if (!basketItem) continue;
        const stats = itemStats.get(key) ?? {
          productIds: new Map<number, number>(),
          names: new Map<number, string>(),
          units: 0,
          packSize: basketItem.packSize,
        };
        stats.productIds.set(basketItem.productId, (stats.productIds.get(basketItem.productId) ?? 0) + 1);
        stats.names.set(basketItem.productId, basketItem.name);
        stats.units += basketItem.units;
        stats.packSize = basketItem.packSize;
        itemStats.set(key, stats);
      }
    }

    const items = [...itemStats.entries()].map(([groupKey, stats]) => {
      const productId = [...stats.productIds.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return {
        productId,
        groupKey,
        name: stats.names.get(productId) ?? `Product ${productId}`,
        quantity: stats.units / cluster.occurrences.length,
        packSize: stats.packSize,
      };
    });

    if (items.length < 2) continue;

    const llm = await nameClusterWithLlm(
      items.map((item) => ({ productId: item.productId, name: item.name, quantity: item.quantity })),
      useLLM
    );
    const servings = llm?.servings ?? 4;
    const name = llm?.name ?? fallbackName(items);

    const lastSeen = cluster.occurrences.reduce(
      (latest, basket) => (basket.date > latest ? basket.date : latest),
      cluster.occurrences[0].date
    );

    detected.push({
      key: basketKey(cluster.keys),
      name,
      aliases: llm?.aliases ?? [],
      items: items.map((item) => ({
        productId: item.productId,
        name: item.name,
        groupKey: item.groupKey,
        qtyPerServing: Math.max(0.01, item.quantity / servings),
        packSize: item.packSize,
        core: llm ? llm.coreIds.has(item.productId) : true,
      })),
      basisServings: servings,
      occurrences: cluster.occurrences.length,
      lastSeen,
      sourceOrders: cluster.occurrences.map((basket) => ({
        orderId: basket.orderId,
        productIds: [...basket.items.values()].map((item) => item.productId),
      })),
    });
  }

  for (const occasion of detected) {
    const existing = await Occasion.findOne({ userId, key: occasion.key });
    if (existing?.manualEdits) {
      // Keep the user's corrections; only refresh the evidence.
      existing.occurrences = occasion.occurrences;
      existing.lastSeen = occasion.lastSeen;
      existing.sourceOrders = occasion.sourceOrders;
      await existing.save();
      continue;
    }

    await Occasion.findOneAndUpdate(
      { userId, key: occasion.key },
      {
        $set: {
          name: occasion.name,
          aliases: occasion.aliases,
          items: occasion.items,
          basisServings: occasion.basisServings,
          occurrences: occasion.occurrences,
          lastSeen: occasion.lastSeen,
          sourceOrders: occasion.sourceOrders,
          manualEdits: false,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
  }

  await Occasion.deleteMany({
    userId,
    manualEdits: false,
    key: { $nin: detected.map((occasion) => occasion.key) },
  });

  await tagOccasionOrders(userId);

  return detected;
}

function normalizeOccasionText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fuzzy match by name or alias. The LLM is only a fallback. */
export function matchOccasion<T extends { name: string; aliases?: string[] }>(
  occasions: T[],
  query: string
): T | null {
  const normalizedQuery = normalizeOccasionText(query);
  if (!normalizedQuery) return null;

  let best: { occasion: T; score: number } | null = null;

  for (const occasion of occasions) {
    const candidates = [occasion.name, ...(occasion.aliases ?? [])];
    for (const candidate of candidates) {
      const normalized = normalizeOccasionText(candidate);
      if (!normalized) continue;

      let score = 0;
      if (normalized === normalizedQuery) score = 1;
      else if (normalized.includes(normalizedQuery) || normalizedQuery.includes(normalized)) score = 0.85;
      else {
        const a = new Set(normalized.split(' '));
        const b = new Set(normalizedQuery.split(' '));
        let intersection = 0;
        for (const token of a) if (b.has(token)) intersection++;
        score = intersection / (a.size + b.size - intersection);
      }

      if (score >= 0.6 && (!best || score > best.score)) {
        best = { occasion, score };
      }
    }
  }

  return best?.occasion ?? null;
}

/** LLM fallback when fuzzy matching finds nothing. Names only, no data. */
export async function matchOccasionWithLlm(query: string, names: string[]): Promise<string | null> {
  if (names.length === 0 || !getOpencodeConfig()) return null;

  try {
    const response = await runPrompt<{ match?: unknown }>(
      [
        'Match a user request to one of these known grocery occasions.',
        'Respond with only JSON: {"match": string|null}. Use the exact known name, or null.',
        `Known occasions: ${names.join(', ')}`,
        `Request: ${JSON.stringify(query)}`,
      ].join('\n'),
      { timeoutMs: 30_000 }
    );
    return typeof response.match === 'string' && names.includes(response.match) ? response.match : null;
  } catch (error) {
    console.error('opencode occasion match failed:', error);
    return null;
  }
}

/** Names to suggest when nothing matches. */
export function closestOccasionNames<T extends { name: string; aliases?: string[] }>(
  occasions: T[],
  query: string,
  limit = 3
): string[] {
  const normalizedQuery = normalizeOccasionText(query);
  const scored = occasions.map((occasion) => {
    const normalized = normalizeOccasionText(occasion.name);
    const a = new Set(normalized.split(' '));
    const b = new Set(normalizedQuery.split(' '));
    let intersection = 0;
    for (const token of a) if (b.has(token)) intersection++;
    return { name: occasion.name, score: intersection / Math.max(1, a.size + b.size - intersection) };
  });
  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.name);
}

/** Packs needed for a per-serving quantity. Exported for tests and the UI. */
export function occasionPacks(qtyPerServing: number, servings: number, packSize: number): number {
  return Math.max(1, Math.ceil((qtyPerServing * servings) / Math.max(1, packSize)));
}

interface OccasionDoc {
  _id: mongoose.Types.ObjectId;
  name: string;
  aliases?: string[];
  items: Array<{
    productId: number;
    name: string;
    groupKey?: string;
    qtyPerServing: number;
    packSize: number;
    core: boolean;
  }>;
  basisServings: number;
}

/** Fill a learned occasion, scaled to the requested servings. */
export async function fillOccasion(
  userId: string,
  derivedKey: Buffer | undefined,
  occasionId: string,
  servings: number,
  options: { confirm?: boolean } = {}
): Promise<FillResult> {
  if (!derivedKey) throw new Error('Session key missing — please re-login');
  if (!mongoose.isValidObjectId(occasionId)) throw new Error('Invalid occasion id');

  const occasion = await Occasion.findOne({ _id: occasionId, userId }).lean<OccasionDoc | null>();
  if (!occasion) throw new Error('Occasion not found');

  const settings = await getBotSettings(userId);
  const weeklyPlan = await planWeeklyFill(userId, settings);
  const weeklyByGroup = new Map(weeklyPlan.consumption.map((item) => [item.groupKey, item]));

  const intent: FillResult['intent'] = {
    type: 'occasion',
    occasion: occasion.name,
    occasionId: String(occasion._id),
    servings,
  };

  const session = await getKnusprSession(userId, derivedKey);
  const cart = await getCart(userId, session);
  const inCart = cartQuantityByProduct(cart);

  const occasionGroups = occasion.items
    .filter((item) => item.core)
    .map((item) => item.groupKey)
    .filter((key): key is string => !!key);

  const groupProductIds = await productIdsForGroups(userId, occasionGroups);
  const prices = await fetchPrices(session, [...groupProductIds.values()].flat());

  const planned: PlannedItem[] = [];
  const skipped: string[] = [];

  for (const item of occasion.items) {
    if (!item.core) continue;

    const groupIds = item.groupKey ? groupProductIds.get(item.groupKey) ?? [item.productId] : [item.productId];
    if (groupIds.some((productId) => inCart.has(productId))) {
      skipped.push(item.name);
      continue;
    }

    let qty = occasionPacks(item.qtyPerServing, servings, item.packSize);
    let reason = `${occasion.name} ×${servings}`;

    if (item.groupKey) {
      const weekly = weeklyByGroup.get(item.groupKey);
      if (weekly && weekly.qty > qty) {
        qty = weekly.qty;
        reason += '; covers weekly fill';
      }
    }

    const variant = chooseVariant(groupIds, item.productId, prices);
    planned.push({
      productId: variant.productId,
      name: item.name,
      qty,
      reason: variant.reason ? `${reason}; ${variant.reason}` : reason,
      groupKey: item.groupKey ?? `product:${item.productId}`,
      price: variant.price?.effectivePrice ?? 0,
    });
  }

  const estimatedTotal = planned.reduce((sum, item) => sum + item.price * item.qty, 0);

  if (planned.length === 0) {
    return {
      status: 'nothing-to-add',
      intent,
      items: [],
      estimatedTotal: 0,
      cart,
      skipped,
      maxEuro: settings.maxEuro,
      maxItems: settings.maxItems,
    };
  }

  if (!options.confirm && (estimatedTotal > settings.maxEuro || planned.length > settings.maxItems)) {
    return {
      status: 'requires-confirmation',
      intent,
      items: planned,
      estimatedTotal,
      cart,
      skipped,
      maxEuro: settings.maxEuro,
      maxItems: settings.maxItems,
    };
  }

  const { added, failed } = await addItems(
    session,
    planned.map((item) => ({ productId: item.productId, amount: item.qty }))
  );
  const addedIds = new Set(added.map((line) => line.productId));
  const addedItems = planned.filter((item) => addedIds.has(item.productId));
  const actualTotal = addedItems.reduce((sum, item) => sum + item.price * item.qty, 0);

  const run = await BotRun.create({
    userId,
    intent,
    items: addedItems,
    totalPrice: actualTotal,
    status: 'in-cart',
  });

  let updatedCart = cart;
  try {
    const raw = await checkCart(session);
    updatedCart = raw ? await normalizeCart(userId, raw) : cart;
  } catch {
    // Non-fatal.
  }

  return {
    status: addedItems.length > 0 ? 'added' : 'nothing-to-add',
    intent,
    items: addedItems,
    estimatedTotal: actualTotal,
    run,
    cart: updatedCart,
    skipped,
    failed: failed.map((entry) => ({ productId: entry.item.productId, error: entry.error })),
    maxEuro: settings.maxEuro,
    maxItems: settings.maxItems,
  };
}

async function productIdsForGroups(userId: string, groupKeys: string[]): Promise<Map<string, number[]>> {
  const groups = await getProductGroupMap(userId);
  const result = new Map<string, number[]>();
  for (const group of groups.values()) {
    if (groupKeys.includes(group.key)) result.set(group.key, group.productIds);
  }
  return result;
}

/** Chat correction: remove an item from an occasion for next time. */
export async function removeOccasionItem(
  userId: string,
  itemName: string,
  occasionQuery?: string,
  lastOccasionId?: string
): Promise<{ occasionName: string; removed: string[] } | null> {
  const occasions = await Occasion.find({ userId }).lean<OccasionDoc[]>();
  let occasion: OccasionDoc | null = null;

  if (occasionQuery) {
    occasion = matchOccasion(occasions, occasionQuery);
  }
  if (!occasion && lastOccasionId) {
    occasion = occasions.find((entry) => String(entry._id) === lastOccasionId) ?? null;
  }
  if (!occasion) {
    occasion = occasions.find((entry) =>
      entry.items.some((item) => normalizeOccasionText(item.name).includes(normalizeOccasionText(itemName)))
    ) ?? null;
  }
  if (!occasion) return null;

  const normalizedItem = normalizeOccasionText(itemName);
  const removed = occasion.items.filter((item) =>
    normalizeOccasionText(item.name).includes(normalizedItem) ||
    normalizedItem.includes(normalizeOccasionText(item.name))
  );

  if (removed.length === 0) return null;

  await Occasion.updateOne(
    { _id: occasion._id, userId },
    {
      $pull: { items: { productId: { $in: removed.map((item) => item.productId) } } },
      $set: { manualEdits: true },
    }
  );

  return { occasionName: occasion.name, removed: removed.map((item) => item.name) };
}
