import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDB, clearDB, teardownTestDB } from '../../api/__tests__/helpers';
import Occasion from '../../models/Occasion';
import type { FillCandidate, FillResult } from '../bot/fill';

// Cart and LLM boundaries are mocked; occasions, merging and confirmation run for real.
const { executeCandidates, planWeeklyFill, resolveRecipe } = vi.hoisted(() => ({
  executeCandidates: vi.fn(),
  planWeeklyFill: vi.fn(),
  resolveRecipe: vi.fn(),
}));

vi.mock('../bot/fill', async () => {
  const actual = await vi.importActual<typeof import('../bot/fill')>('../bot/fill');
  return { ...actual, executeCandidates, planWeeklyFill };
});
vi.mock('../bot/recipes', () => ({ resolveRecipe }));

const { executeBotMessage, clearPendingConfirmation } = await import('../bot/chat');

const NOW = new Date(2026, 10, 2, 10, 30); // Monday
const KEY = Buffer.from('k');

function weeklyItem(groupKey: string, qty: number) {
  return { groupKey, productIds: [groupKey.length], productId: groupKey.length, name: groupKey, qty, reason: 'every ~5d', avgPrice: 1 };
}

function added(candidates: FillCandidate[], intent: FillResult['intent']): FillResult {
  return {
    status: 'added',
    intent,
    items: candidates.map((c) => ({ productId: c.productId, name: c.name, qty: c.qty, reason: c.reason, groupKey: c.groupKey, price: 1 })),
    estimatedTotal: candidates.reduce((sum, c) => sum + c.qty, 0),
    run: { _id: 'run1' },
    maxEuro: 150,
    maxItems: 30,
  };
}

async function pizzaDraft(userId: string) {
  return Occasion.create({
    userId,
    key: 'recipe:pizza',
    name: 'Pizza',
    aliases: ['pizza'],
    source: 'recipe',
    status: 'draft',
    style: 'homemade',
    basisServings: 1,
    missing: ['passata'],
    items: [
      { productId: 11, name: 'Weizenmehl', groupKey: 'g:mehl', qtyPerServing: 125, packSize: 1000, core: true },
      { productId: 12, name: 'Hefe', groupKey: 'g:hefe', qtyPerServing: 4, packSize: 42, core: true },
      { productId: 13, name: 'Mozzarella', groupKey: 'g:mozz', qtyPerServing: 60, packSize: 125, core: true },
    ],
  });
}

beforeAll(setupTestDB);
afterAll(teardownTestDB);

describe('executeBotMessage', () => {
  let userId: string;

  beforeEach(async () => {
    await clearDB();
    userId = new mongoose.Types.ObjectId().toString();
    clearPendingConfirmation(userId);
    executeCandidates.mockReset().mockImplementation(async (_u, _k, candidates, intent) => added(candidates, intent));
    planWeeklyFill.mockReset().mockResolvedValue({
      items: [],
      consumption: [weeklyItem('g:milk', 3), weeklyItem('g:mozz', 2)],
      settings: { maxEuro: 150, maxItems: 30, horizonDays: 7, deliveryLeadDays: 2, opencodeEnabled: true },
    });
    resolveRecipe.mockReset();
  });

  it('runs the weekly part now and shows an unknown dish as a homemade draft', async () => {
    resolveRecipe.mockImplementation(async (uid: string) => {
      const occasion = await pizzaDraft(uid);
      return {
        occasion: occasion.toObject(),
        choice: {
          style: 'homemade',
          confident: true,
          coverage: 0.75,
          missing: ['passata'],
          evidence: [
            { label: 'Hefe', purchaseCount: 5 },
            { label: 'Weizenmehl', purchaseCount: 8 },
            { label: 'Mozzarella', purchaseCount: 11 },
          ],
        },
      };
    });

    const result = await executeBotMessage(
      userId,
      'i have pizza event for 6 at wednesday and needs some food till end of the week',
      KEY,
      { now: NOW }
    );

    // Weekly horizon: Monday through Sunday.
    expect(planWeeklyFill.mock.calls[0][2]).toEqual({ horizonDays: 7 });
    // Only the weekly items reach the cart; the draft waits.
    expect(executeCandidates).toHaveBeenCalledTimes(1);
    const candidates = executeCandidates.mock.calls[0][2] as FillCandidate[];
    expect(candidates.map((c) => c.groupKey).sort()).toEqual(['g:milk', 'g:mozz']);

    expect(result.status).toBe('requires-confirmation');
    expect(result.reply).toContain('You make pizza yourself');
    expect(result.reply).toContain('Hefe (5×)');
    expect(result.reply).toContain('Not in your history (add yourself): passata');
    expect(result.drafts?.[0]).toMatchObject({ name: 'Pizza', servings: 6, date: 'Wed', style: 'homemade' });
    // 60 g × 6 people = 360 g → 3 packs of 125 g
    expect(result.drafts?.[0].items).toContainEqual({ name: 'Mozzarella', qty: 3 });
  });

  it('adds the draft on "yes" and saves the recipe as confirmed', async () => {
    resolveRecipe.mockImplementation(async (uid: string) => ({
      occasion: (await pizzaDraft(uid)).toObject(),
      choice: { style: 'homemade', confident: true, coverage: 1, missing: [], evidence: [] },
    }));
    await executeBotMessage(userId, 'pizza for 6 on wednesday', KEY, { now: NOW });
    expect(executeCandidates).not.toHaveBeenCalled();

    const confirmed = await executeBotMessage(userId, 'yes', KEY, { now: NOW });

    expect(executeCandidates).toHaveBeenCalledTimes(1);
    const [, , candidates, intent, , options] = executeCandidates.mock.calls[0];
    expect((candidates as FillCandidate[]).map((c) => c.name)).toEqual(['Weizenmehl', 'Hefe', 'Mozzarella']);
    expect(intent).toMatchObject({ type: 'occasion', occasion: 'Pizza', servings: 6 });
    expect(options).toEqual({ confirm: true });
    expect(confirmed.reply).toContain('next time it goes straight into the cart');
    expect((await Occasion.findOne({ userId, key: 'recipe:pizza' }).lean())?.status).toBe('confirmed');
  });

  it('fills a confirmed recipe and the weekly part as one run without duplicates', async () => {
    await pizzaDraft(userId);
    await Occasion.updateOne({ userId, key: 'recipe:pizza' }, { $set: { status: 'confirmed' } });

    const result = await executeBotMessage(userId, 'pizza for 6 on wednesday and groceries till sunday', KEY, { now: NOW });

    expect(resolveRecipe).not.toHaveBeenCalled();
    expect(executeCandidates).toHaveBeenCalledTimes(1);
    const [, , candidates, intent] = executeCandidates.mock.calls[0];
    const byGroup = new Map((candidates as FillCandidate[]).map((c) => [c.groupKey, c]));
    expect([...byGroup.keys()].sort()).toEqual(['g:hefe', 'g:mehl', 'g:milk', 'g:mozz']);
    // Mozzarella: pizza needs 3 packs, weekly 2 → 3, both reasons kept.
    expect(byGroup.get('g:mozz')).toMatchObject({ qty: 3, reason: 'Pizza ×6 (Wed); every ~5d' });
    expect(intent).toMatchObject({ type: 'plan', summary: 'Pizza ×6 (Wed) + your usual groceries till Sun' });
    expect(result.status).toBe('added');
  });

  it('explains instead of refusing when nothing can be built', async () => {
    resolveRecipe.mockResolvedValue(null);
    const result = await executeBotMessage(userId, 'sushi for 2', KEY, { now: NOW });
    expect(result.reply).toContain("couldn't build “sushi” from your products");
    expect(result.reply).not.toContain('I do not invent recipes');
  });
});
