import crypto from 'node:crypto';
import BotSettings from '../../models/BotSettings';
import Occasion from '../../models/Occasion';
import { getOpencodeConfig, runPrompt } from '../opencode-client';
import { loadPurchases, type Purchase } from './consumption';

/**
 * Recipes built from the user's own products.
 *
 * The LLM supplies general cooking knowledge only: which ingredients a dish
 * needs, per person, and which entry of the user's product list each one is.
 * Everything else is decided here: a match must point into the list we sent,
 * and whether the user cooks a dish from scratch or buys it ready-made comes
 * from their purchase history, not from the model.
 */

export interface GroupStat {
  key: string;
  label: string;
  /** Most bought product in the group: the one to put in the cart. */
  productId: number;
  name: string;
  productIds: number[];
  purchaseCount: number;
  lastBought: Date;
  packSize: number;
  packUnit: 'g' | 'ml' | 'piece';
}

export type RecipeStyle = 'homemade' | 'ready-made';
export type IngredientUnit = 'g' | 'ml' | 'piece';

export interface RecipeIngredient {
  ingredient: string;
  qtyPerServing: number;
  unit: IngredientUnit;
  core: boolean;
  /** Index into the group list sent to the model, or null. */
  match: number | null;
}

export interface RecipeVariant {
  style: RecipeStyle;
  ingredients: RecipeIngredient[];
}

export interface RecipeChoice {
  variant: RecipeVariant;
  style: RecipeStyle;
  coverage: number;
  /** Matched core groups bought at least EVIDENCE_MIN_PURCHASES times. */
  evidence: GroupStat[];
  /** Core ingredients with no match. */
  missing: string[];
  /** False when the pick rests on coverage alone, without regular buying. */
  confident: boolean;
}

export interface RecipeOccasionItem {
  productId: number;
  name: string;
  groupKey: string;
  qtyPerServing: number;
  packSize: number;
  core: boolean;
}

const HOMEMADE_MIN_COVERAGE = 0.6;
const EVIDENCE_MIN_PURCHASES = 2;
const HOMEMADE_MIN_EVIDENCE = 2;
const DISCOVERY_MIN_EVIDENCE = 3;
const MAX_GROUPS_IN_PROMPT = 300;
const HISTORY_WINDOW_DAYS = 365;
const DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Fallback when the recipe unit does not match the product: 1 pack per 4 people. */
const FALLBACK_PACKS_PER_SERVING = 0.25;

function mostCommon<T>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** One entry per product group, most bought first. */
export function summarizeGroups(purchases: Purchase[]): GroupStat[] {
  const byGroup = new Map<string, Purchase[]>();
  for (const purchase of purchases) {
    const list = byGroup.get(purchase.groupKey) ?? [];
    list.push(purchase);
    byGroup.set(purchase.groupKey, list);
  }

  const groups: GroupStat[] = [];
  for (const [key, list] of byGroup) {
    const productId = mostCommon(list.map((purchase) => purchase.productId));
    const product = list.find((purchase) => purchase.productId === productId)!;
    groups.push({
      key,
      label: list[0].groupLabel,
      productId,
      name: product.name,
      productIds: list[0].groupProductIds,
      purchaseCount: new Set(list.map((purchase) => purchase.orderId)).size,
      lastBought: list.reduce((latest, purchase) => (purchase.date > latest ? purchase.date : latest), list[0].date),
      packSize: mostCommon(list.map((purchase) => purchase.packSize)),
      packUnit: mostCommon(list.map((purchase) => purchase.packUnit ?? 'piece')),
    });
  }
  return groups.sort((a, b) => b.purchaseCount - a.purchaseCount || a.label.localeCompare(b.label));
}

function normalizeUnit(value: unknown): IngredientUnit {
  const unit = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['g', 'gram', 'grams', 'gramm', 'kg'].includes(unit)) return 'g';
  if (['ml', 'l', 'millilitre', 'milliliter', 'litre', 'liter'].includes(unit)) return 'ml';
  return 'piece';
}

function normalizeIngredient(raw: unknown, groupCount: number): RecipeIngredient | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const ingredient = typeof value.ingredient === 'string' ? value.ingredient.trim() : '';
  let qtyPerServing = Number(value.qtyPerServing);
  if (!ingredient || !Number.isFinite(qtyPerServing) || qtyPerServing <= 0) return null;
  const rawUnit = typeof value.unit === 'string' ? value.unit.trim().toLowerCase() : '';
  if (rawUnit === 'kg' || rawUnit === 'l' || rawUnit === 'liter' || rawUnit === 'litre') qtyPerServing *= 1000;
  const match = Number.isInteger(value.match) && (value.match as number) >= 0 && (value.match as number) < groupCount
    ? (value.match as number)
    : null;
  return {
    ingredient,
    qtyPerServing,
    unit: normalizeUnit(value.unit),
    core: value.core !== false,
    match,
  };
}

/** Validate the model's reply. A match outside the list we sent becomes null. */
export function normalizeRecipeVariants(raw: unknown, groupCount: number): RecipeVariant[] {
  if (!raw || typeof raw !== 'object') return [];
  const variants = (raw as { variants?: unknown }).variants;
  if (!Array.isArray(variants)) return [];

  const result: RecipeVariant[] = [];
  for (const entry of variants) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as { style?: unknown; ingredients?: unknown };
    if (value.style !== 'homemade' && value.style !== 'ready-made') continue;
    if (!Array.isArray(value.ingredients)) continue;
    const ingredients = value.ingredients
      .map((ingredient) => normalizeIngredient(ingredient, groupCount))
      .filter((ingredient): ingredient is RecipeIngredient => ingredient !== null);
    if (ingredients.length > 0) result.push({ style: value.style, ingredients });
  }
  return result;
}

function scoreVariant(variant: RecipeVariant, groups: GroupStat[]) {
  const core = variant.ingredients.filter((ingredient) => ingredient.core);
  const matched = core.filter((ingredient) => ingredient.match !== null);
  const evidence = matched
    .map((ingredient) => groups[ingredient.match!])
    .filter((group) => group.purchaseCount >= EVIDENCE_MIN_PURCHASES);
  return {
    coverage: core.length > 0 ? matched.length / core.length : 0,
    evidence: [...new Map(evidence.map((group) => [group.key, group])).values()],
    missing: core.filter((ingredient) => ingredient.match === null).map((ingredient) => ingredient.ingredient),
  };
}

/**
 * Homemade when most core ingredients are in the history and several are
 * bought regularly; ready-made when the prepared product is bought; otherwise
 * the best-covered variant, flagged as not confident.
 */
export function chooseRecipeVariant(variants: RecipeVariant[], groups: GroupStat[]): RecipeChoice | null {
  const scored = variants.map((variant) => ({ variant, ...scoreVariant(variant, groups) }));
  const toChoice = (entry: (typeof scored)[number], confident: boolean): RecipeChoice => ({
    variant: entry.variant,
    style: entry.variant.style,
    coverage: entry.coverage,
    evidence: entry.evidence,
    missing: entry.missing,
    confident,
  });

  const homemade = scored.find(
    (entry) =>
      entry.variant.style === 'homemade' &&
      entry.coverage >= HOMEMADE_MIN_COVERAGE &&
      entry.evidence.length >= HOMEMADE_MIN_EVIDENCE
  );
  if (homemade) return toChoice(homemade, true);

  const readyMade = scored.find(
    (entry) => entry.variant.style === 'ready-made' && entry.coverage > 0 && entry.evidence.length >= 1
  );
  if (readyMade) return toChoice(readyMade, true);

  const best = scored
    .filter((entry) => entry.coverage > 0)
    .sort((a, b) => b.coverage - a.coverage || (a.variant.style === 'homemade' ? -1 : 1))[0];
  return best ? toChoice(best, false) : null;
}

/** Occasion items for the matched ingredients, in the units of the user's products. */
export function recipeItems(variant: RecipeVariant, groups: GroupStat[]): RecipeOccasionItem[] {
  const items: RecipeOccasionItem[] = [];
  const seen = new Set<string>();
  for (const ingredient of variant.ingredients) {
    if (ingredient.match === null) continue;
    const group = groups[ingredient.match];
    if (!group || seen.has(group.key)) continue;
    seen.add(group.key);

    const unitsMatch = ingredient.unit === group.packUnit;
    items.push({
      productId: group.productId,
      name: group.name,
      groupKey: group.key,
      qtyPerServing: unitsMatch ? ingredient.qtyPerServing : FALLBACK_PACKS_PER_SERVING,
      packSize: unitsMatch ? group.packSize : 1,
      core: ingredient.core,
    });
  }
  return items;
}

function productList(groups: GroupStat[]): string {
  return groups.map((group, index) => `${index}: ${group.label} (${group.purchaseCount}×)`).join('\n');
}

const INGREDIENT_SHAPE =
  '{"ingredient":string,"qtyPerServing":number,"unit":"g"|"ml"|"piece","core":boolean,"match":number|null}';

function buildRecipePrompt(dish: string, servings: number, groups: GroupStat[]): string {
  return [
    'Plan the groceries for a dish. Respond with only JSON, no prose.',
    `Dish: ${JSON.stringify(dish)} for ${servings} people.`,
    'Give a "homemade" variant (cooked from scratch) and, if the dish is commonly bought prepared, a "ready-made" variant.',
    `Shape: {"variants":[{"style":"homemade"|"ready-made","ingredients":[${INGREDIENT_SHAPE}]}]}`,
    'qtyPerServing is the amount for ONE person. core=false for garnish or optional extras.',
    'match is the number of the product below that IS this ingredient, or null if none fits. Use only numbers from this list.',
    'Products this person has bought (number: name (times bought)):',
    productList(groups),
  ].join('\n');
}

function buildDiscoveryPrompt(groups: GroupStat[]): string {
  return [
    'Judging by the groceries this person buys, which dishes do they likely cook from scratch?',
    'Respond with only JSON, no prose. Up to 6 dishes, most likely first.',
    `Shape: {"dishes":[{"dish":string,"aliases":string[],"ingredients":[${INGREDIENT_SHAPE}]}]}`,
    '"dish" is one or two lowercase words (e.g. "pizza", "lasagne"). qtyPerServing is for ONE person.',
    'match is the number of the product below that IS this ingredient, or null if none fits. Use only numbers from this list.',
    'Products (number: name (times bought)):',
    productList(groups),
  ].join('\n');
}

export async function loadGroupStats(userId: string): Promise<GroupStat[]> {
  const { purchases } = await loadPurchases(userId, { windowDays: HISTORY_WINDOW_DAYS });
  return summarizeGroups(purchases).slice(0, MAX_GROUPS_IN_PROMPT);
}

function occasionKey(dish: string): string {
  return `recipe:${dish.trim().toLowerCase().replace(/\s+/g, '-')}`;
}

function titleCase(dish: string): string {
  return dish.trim().replace(/\b\p{L}/gu, (char) => char.toUpperCase());
}

async function saveRecipe(
  userId: string,
  dish: string,
  aliases: string[],
  choice: RecipeChoice,
  groups: GroupStat[],
  source: 'recipe' | 'discovered'
) {
  const key = occasionKey(dish);
  const existing = await Occasion.findOne({ userId, key });
  // Never overwrite a recipe the user confirmed or edited.
  if (existing && (existing.status === 'confirmed' || existing.manualEdits)) return existing;

  return Occasion.findOneAndUpdate(
    { userId, key },
    {
      $set: {
        name: titleCase(dish),
        aliases: [...new Set([dish.toLowerCase(), ...aliases.map((alias) => alias.toLowerCase())])],
        items: recipeItems(choice.variant, groups),
        basisServings: 1,
        source,
        status: 'draft',
        style: choice.style,
        missing: choice.missing,
        evidence: choice.evidence.map((group) => ({ label: group.label, purchaseCount: group.purchaseCount })),
        manualEdits: false,
      },
      $setOnInsert: { occurrences: 0 },
    },
    { upsert: true, returnDocument: 'after' }
  );
}

export interface ResolvedRecipe {
  occasion: { _id: unknown; name: string; status: string; items: RecipeOccasionItem[] };
  choice: RecipeChoice;
}

/**
 * Build a draft recipe for a dish the bot has not learned yet, from the
 * user's own products. Returns null without opencode or without any match.
 */
export async function resolveRecipe(userId: string, dish: string, servings: number): Promise<ResolvedRecipe | null> {
  if (!getOpencodeConfig()) return null;
  const groups = await loadGroupStats(userId);
  if (groups.length === 0) return null;

  let raw: unknown;
  try {
    raw = await runPrompt<unknown>(buildRecipePrompt(dish, servings, groups), { timeoutMs: 60_000 });
  } catch (error) {
    console.error('opencode recipe planning failed:', error);
    return null;
  }

  const choice = chooseRecipeVariant(normalizeRecipeVariants(raw, groups.length), groups);
  if (!choice) return null;
  const occasion = await saveRecipe(userId, dish, [], choice, groups, 'recipe');
  return occasion ? { occasion: occasion.toObject(), choice } : null;
}

function groupsHash(groups: GroupStat[]): string {
  return crypto.createHash('sha1').update(groups.map((group) => group.key).sort().join('|')).digest('hex');
}

/**
 * Background: suggest dishes the user's ingredients point to. At most once a
 * day, and only when the product groups changed. Kept only with at least
 * DISCOVERY_MIN_EVIDENCE regularly bought core ingredients.
 */
export async function discoverRecipes(userId: string, options: { force?: boolean } = {}): Promise<number> {
  if (!getOpencodeConfig()) return 0;
  const settings = await BotSettings.findOne({ userId }).lean<{ opencodeEnabled?: boolean; recipeDiscovery?: { at?: Date; groupsHash?: string } } | null>();
  if (settings?.opencodeEnabled === false) return 0;

  const groups = await loadGroupStats(userId);
  if (groups.length === 0) return 0;
  const hash = groupsHash(groups);
  const last = settings?.recipeDiscovery;
  if (
    !options.force &&
    last?.at &&
    (Date.now() - new Date(last.at).getTime() < DISCOVERY_INTERVAL_MS || last.groupsHash === hash)
  ) {
    return 0;
  }

  await BotSettings.updateOne(
    { userId },
    { $set: { recipeDiscovery: { at: new Date(), groupsHash: hash } } },
    { upsert: true }
  );

  let raw: unknown;
  try {
    raw = await runPrompt<unknown>(buildDiscoveryPrompt(groups), { timeoutMs: 90_000 });
  } catch (error) {
    console.error('opencode recipe discovery failed:', error);
    return 0;
  }

  const dishes = Array.isArray((raw as { dishes?: unknown })?.dishes) ? (raw as { dishes: unknown[] }).dishes : [];
  let saved = 0;
  for (const entry of dishes.slice(0, 6)) {
    const value = (entry ?? {}) as { dish?: unknown; aliases?: unknown; ingredients?: unknown };
    const dish = typeof value.dish === 'string' ? value.dish.trim().toLowerCase() : '';
    if (!dish) continue;
    const [variant] = normalizeRecipeVariants(
      { variants: [{ style: 'homemade', ingredients: value.ingredients }] },
      groups.length
    );
    if (!variant) continue;
    const choice = chooseRecipeVariant([variant], groups);
    if (!choice || choice.evidence.length < DISCOVERY_MIN_EVIDENCE || choice.coverage < HOMEMADE_MIN_COVERAGE) continue;
    const aliases = Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === 'string') : [];
    await saveRecipe(userId, dish, aliases, choice, groups, 'discovered');
    saved++;
  }
  return saved;
}
