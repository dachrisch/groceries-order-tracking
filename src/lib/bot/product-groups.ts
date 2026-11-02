import mongoose from 'mongoose';
import Order from '../../models/Order';
import ProductGroup from '../../models/ProductGroup';

/**
 * Product grouping — rules only, no AI.
 *
 * Knuspr gives near-identical products different IDs ("Bio Vollmilch 3,5% 1l"
 * vs "Knuspr Vollmilch 1l"), so every learned pattern must work on groups
 * instead of raw product IDs.
 */

export interface KnusprCategory {
  id?: number;
  name?: string;
  slug?: string;
  level?: number;
}

export interface ProductMeta {
  id: number;
  name: string;
  textualAmount?: string;
  unit?: string;
  categories?: KnusprCategory[];
  /** How often the product was bought; used to pick a label and representative. */
  purchaseCount?: number;
}

export interface ProductSize {
  /** Normalized base amount: grams for weight, millilitres for volume, pieces otherwise. */
  value: number;
  unit: 'g' | 'ml' | 'piece';
}

export interface ParsedProductName {
  /** Lowercase, de-umlauted name with brand, size, percentage and packaging removed. */
  normalized: string;
  tokens: string[];
  size: ProductSize | null;
}

export interface BuiltGroup {
  key: string;
  label: string;
  productIds: number[];
  manual: boolean;
}

/** Brands we know are noise for grouping. Extend as new ones show up. */
const KNOWN_BRANDS = [
  'knuspr', 'bio', 'alnatura', 'alpro', 'oatly', 'andechser', 'berchtesgadener',
  'weihenstephan', 'mueller', 'müllermilch', 'muellermilch', 'danone', 'ehrmann',
  'landliebe', 'arla', 'kerrygold', 'meggle', 'patros', 'gervais', 'philadelphia',
  'rama', 'du darfst', 'iglo', 'frosta', 'wagner', 'dr oetker', 'maggi', 'knorr',
  'barilla', 'de cecco', 'buitoni', 'mutti', 'cirio', 'kuehne', 'kühne',
  'hengstenberg', 'bonduelle', 'coca cola', 'coca-cola', 'red bull', 'volvic',
  'evian', 'gerolsteiner', 'vittel', 'nescafe', 'jacobs', 'tchibo', 'lavazza',
  'ritter sport', 'milka', 'lindt', 'kinder', 'ferrero', 'haribo', 'seeberger',
  'ja!', 'gut & guenstig', 'gut & günstig', 'ja', 'freixenet', 'rotkaeppchen',
];

/** Packaging noise that never helps distinguish products. */
const PACKAGING_WORDS = [
  'packung', 'pack', 'paeckchen', 'päckchen', 'beutel', 'becher', 'flasche',
  'dose', 'glas', 'karton', 'tuete', 'tüte', 'tube', 'spender', 'kiste', 'netz',
  'bund', 'stueck', 'stück', 'stk', 'st', 'mehrweg', 'pfand',
];

const UMLAUT_MAP: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', é: 'e', è: 'e', ê: 'e', à: 'a', â: 'a',
  ç: 'c', ô: 'o', î: 'i', ï: 'i', û: 'u', ù: 'u',
};

export function deumlaut(value: string): string {
  return value
    .toLowerCase()
    .replace(/[äöüßéèêàâçôîïûù]/g, (char) => UMLAUT_MAP[char] ?? char);
}

function parseNumber(value: string): number {
  return Number(value.replace(',', '.'));
}

/**
 * Extract a normalized pack size. Handles "1l", "500 g", "6x0,33l" and
 * "1,5 kg". Returns null when the product has no measurable amount.
 */
export function parseSize(textualAmount?: string, unit?: string): ProductSize | null {
  const text = `${textualAmount ?? ''} ${unit ?? ''}`.trim();
  if (!text) return null;

  const multipack = text.match(/(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|cl)\b/i);
  if (multipack) {
    const count = Number(multipack[1]);
    return toBaseSize(parseNumber(multipack[2]) * count, multipack[3]);
  }

  const single = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|cl)\b/i);
  if (single) {
    return toBaseSize(parseNumber(single[1]), single[2]);
  }

  return null;
}

function toBaseSize(value: number, unit: string): ProductSize {
  const normalizedUnit = unit.toLowerCase();
  if (normalizedUnit === 'kg') return { value: value * 1000, unit: 'g' };
  if (normalizedUnit === 'g') return { value, unit: 'g' };
  if (normalizedUnit === 'l') return { value: value * 1000, unit: 'ml' };
  if (normalizedUnit === 'cl') return { value: value * 10, unit: 'ml' };
  return { value, unit: 'ml' };
}

function stripKnownWords(text: string, words: string[]): string {
  let result = text;
  // Longest first so "muellermilch" is removed before "mueller".
  for (const word of [...words].sort((a, b) => b.length - a.length)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'gi'), ' ');
  }
  return result;
}

/**
 * Normalize a product name for similarity comparison. Brand tokens can be
 * passed in when the caller has detected category-specific brands.
 */
export function normalizeName(name: string, extraBrandTokens: string[] = []): ParsedProductName {
  const size = parseSize(name);
  let text = deumlaut(name);

  // Drop sizes, multipacks, percentages and parenthesised filler.
  text = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\d+\s*[x×]\s*\d+(?:[.,]\d+)?\s*(kg|g|ml|l|cl)\b/gi, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*(kg|g|ml|l|cl)\b/gi, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*%/g, ' ')
    .replace(/[®™©]/g, ' ');

  text = stripKnownWords(text, [...KNOWN_BRANDS, ...extraBrandTokens, ...PACKAGING_WORDS]);

  const tokens = text
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 || /^\d+$/.test(token));

  return {
    normalized: tokens.join(' '),
    tokens,
    size,
  };
}

/** Same leaf category (the one with the highest level). */
export function leafCategory(categories?: KnusprCategory[]): string {
  if (!categories || categories.length === 0) return 'uncategorized';
  const leaf = categories.reduce((best, category) =>
    (category.level ?? 0) > (best.level ?? 0) ? category : best
  );
  return (leaf.slug || leaf.name || 'uncategorized').toLowerCase();
}

/** Sizes are compatible when both are unknown or within ±20%. */
export function sizeCompatible(a: ProductSize | null, b: ProductSize | null): boolean {
  if (!a || !b) return true;
  if (a.unit !== b.unit) return false;
  const ratio = a.value / b.value;
  return ratio >= 0.8 && ratio <= 1.25;
}

function sizeKey(size: ProductSize | null): string {
  if (!size) return 'nosize';
  // Round to two significant digits so 1000 and 1000 stay together while
  // 500 and 1000 stay apart.
  const rounded = Number(size.value.toPrecision(2));
  return `${rounded}${size.unit}`;
}

function tokenSet(tokens: string[]): Set<string> {
  return new Set(tokens);
}

export function tokenSetJaccard(a: string[], b: string[]): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function trigrams(value: string): Set<string> {
  const padded = ` ${value} `;
  const result = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    result.add(padded.slice(i, i + 3));
  }
  return result;
}

export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const trigram of setA) {
    if (setB.has(trigram)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

export function nameSimilarity(a: ParsedProductName, b: ParsedProductName): number {
  return 0.5 * tokenSetJaccard(a.tokens, b.tokens) + 0.5 * trigramSimilarity(a.normalized, b.normalized);
}

/** Union-find with path compression. */
class UnionFind {
  private parent = new Map<number, number>();

  find(id: number): number {
    if (!this.parent.has(id)) this.parent.set(id, id);
    const parent = this.parent.get(id)!;
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

/**
 * Detect brand tokens that appear as the first token across many products in
 * the same leaf category (e.g. a house brand we do not have in the list yet).
 */
function detectCategoryBrands(products: ProductMeta[]): Map<string, string[]> {
  const byCategory = new Map<string, ProductMeta[]>();
  for (const product of products) {
    const category = leafCategory(product.categories);
    const list = byCategory.get(category) ?? [];
    list.push(product);
    byCategory.set(category, list);
  }

  const result = new Map<string, string[]>();
  for (const [category, categoryProducts] of byCategory) {
    const firstTokenCounts = new Map<string, number>();
    for (const product of categoryProducts) {
      const parsed = normalizeName(product.name);
      const first = parsed.tokens[0];
      if (!first) continue;
      firstTokenCounts.set(first, (firstTokenCounts.get(first) ?? 0) + 1);
    }

    const threshold = Math.max(3, Math.ceil(categoryProducts.length * 0.3));
    const brands = [...firstTokenCounts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([token]) => token);

    if (brands.length > 0) result.set(category, brands);
  }
  return result;
}

/**
 * Build rule-based groups from product metadata. Manual groups are returned
 * unchanged and their products are excluded from rule-based grouping.
 */
export function buildProductGroups(products: ProductMeta[], manualGroups: BuiltGroup[] = []): BuiltGroup[] {
  const manualProductIds = new Set<number>();
  for (const group of manualGroups) {
    for (const id of group.productIds) manualProductIds.add(id);
  }

  const ruleProducts = products.filter((product) => !manualProductIds.has(product.id));
  const categoryBrands = detectCategoryBrands(ruleProducts);

  const parsed = new Map<number, ParsedProductName>();
  for (const product of ruleProducts) {
    const category = leafCategory(product.categories);
    parsed.set(product.id, normalizeName(product.name, categoryBrands.get(category) ?? []));
  }

  // Bucket by leaf category to avoid comparing every product with every other.
  const byCategory = new Map<string, ProductMeta[]>();
  for (const product of ruleProducts) {
    const category = leafCategory(product.categories);
    const list = byCategory.get(category) ?? [];
    list.push(product);
    byCategory.set(category, list);
  }

  const unionFind = new UnionFind();
  for (const categoryProducts of byCategory.values()) {
    for (let i = 0; i < categoryProducts.length; i++) {
      for (let j = i + 1; j < categoryProducts.length; j++) {
        const a = categoryProducts[i];
        const b = categoryProducts[j];
        const parsedA = parsed.get(a.id)!;
        const parsedB = parsed.get(b.id)!;
        if (!sizeCompatible(parsedA.size, parsedB.size)) continue;
        if (nameSimilarity(parsedA, parsedB) < 0.7) continue;
        unionFind.union(a.id, b.id);
      }
    }
  }

  const components = new Map<number, ProductMeta[]>();
  for (const product of ruleProducts) {
    const root = unionFind.find(product.id);
    const list = components.get(root) ?? [];
    list.push(product);
    components.set(root, list);
  }

  const ruleGroups: BuiltGroup[] = [];
  for (const component of components.values()) {
    const category = leafCategory(component[0].categories);
    const sizes = component.map((product) => parsed.get(product.id)!.size).filter((size): size is ProductSize => !!size);
    const size = sizes[0] ?? null;

    const allTokens = new Set<string>();
    for (const product of component) {
      for (const token of parsed.get(product.id)!.tokens) allTokens.add(token);
    }

    const representative = [...component].sort(
      (a, b) => (b.purchaseCount ?? 0) - (a.purchaseCount ?? 0)
    )[0];

    ruleGroups.push({
      key: `${category}|${sizeKey(size)}|${[...allTokens].sort().join('+')}`,
      label: representative.name,
      productIds: component.map((product) => product.id).sort((a, b) => a - b),
      manual: false,
    });
  }

  return [...manualGroups, ...ruleGroups].sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

const groupCache = new Map<string, { at: number; groups: BuiltGroup[] }>();
const GROUP_CACHE_TTL_MS = 60_000;

export function invalidateProductGroupCache(userId: string): void {
  groupCache.delete(userId);
}

/**
 * Rebuild rule groups for a user and persist them. Manual groups survive
 * untouched.
 */
export async function rebuildProductGroups(userId: string): Promise<BuiltGroup[]> {
  const objectId = new mongoose.Types.ObjectId(userId);

  const products = await Order.aggregate<{
    _id: number;
    name: string;
    textualAmount?: string;
    unit?: string;
    categories?: KnusprCategory[];
    purchaseCount: number;
  }>([
    { $match: { userId: objectId } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.id',
        name: { $last: '$items.name' },
        textualAmount: { $last: '$items.textualAmount' },
        unit: { $last: '$items.unit' },
        categories: { $last: '$items.categories' },
        purchaseCount: { $sum: 1 },
      },
    },
  ]);

  const manualDocs = await ProductGroup.find({ userId, manual: true }).lean();
  const manualGroups: BuiltGroup[] = manualDocs.map((doc) => ({
    key: doc.key,
    label: doc.label,
    productIds: doc.productIds ?? [],
    manual: true,
  }));

  const groups = buildProductGroups(
    products.map((product) => ({
      id: product._id,
      name: product.name,
      textualAmount: product.textualAmount,
      unit: product.unit,
      categories: product.categories,
      purchaseCount: product.purchaseCount,
    })),
    manualGroups
  );

  await ProductGroup.deleteMany({ userId, manual: false });
  if (groups.length > 0) {
    await ProductGroup.bulkWrite(
      groups
        .filter((group) => !group.manual)
        .map((group) => ({
          updateOne: {
            filter: { userId, key: group.key },
            update: {
              $set: {
                label: group.label,
                productIds: group.productIds,
                manual: false,
              },
            },
            upsert: true,
          },
        }))
    );
  }

  groupCache.set(userId, { at: Date.now(), groups });
  return groups;
}

/** Return groups, rebuilding when the cache is cold. */
export async function getProductGroups(userId: string): Promise<BuiltGroup[]> {
  const cached = groupCache.get(userId);
  if (cached && Date.now() - cached.at < GROUP_CACHE_TTL_MS) return cached.groups;
  return rebuildProductGroups(userId);
}

/** Map every known product ID to its group key. */
export async function getProductGroupMap(userId: string): Promise<Map<number, BuiltGroup>> {
  const groups = await getProductGroups(userId);
  const map = new Map<number, BuiltGroup>();
  for (const group of groups) {
    for (const productId of group.productIds) map.set(productId, group);
  }
  return map;
}
