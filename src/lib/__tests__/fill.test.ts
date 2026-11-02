import { describe, it, expect } from 'vitest';
import { mergeCandidates, type FillCandidate } from '../bot/fill';

const candidate = (groupKey: string, qty: number, reason: string, extra: Partial<FillCandidate> = {}): FillCandidate => ({
  groupKey,
  productIds: [1],
  productId: 1,
  name: groupKey,
  qty,
  reason,
  fallbackPrice: 1,
  ...extra,
});

describe('mergeCandidates', () => {
  it('adds each group once, keeping the larger quantity and both reasons', () => {
    const merged = mergeCandidates([
      [candidate('mozzarella', 3, 'Pizza ×6 (Wed)', { occasionId: 'o1', servings: 6 }), candidate('flour', 1, 'Pizza ×6 (Wed)')],
      [candidate('mozzarella', 2, 'every ~5d'), candidate('milk', 3, 'every ~4d')],
    ]);

    expect(merged.map((item) => item.groupKey)).toEqual(['mozzarella', 'flour', 'milk']);
    const mozzarella = merged[0];
    expect(mozzarella.qty).toBe(3);
    expect(mozzarella.reason).toBe('Pizza ×6 (Wed); every ~5d');
    // Shared with the weekly fill, so the delivery can't teach the recipe.
    expect(mozzarella.occasionId).toBeUndefined();
  });

  it('keeps the occasion link for items only the occasion needs', () => {
    const merged = mergeCandidates([[candidate('yeast', 1, 'Pizza ×6', { occasionId: 'o1', servings: 6 })], []]);
    expect(merged[0].occasionId).toBe('o1');
    expect(merged[0].servings).toBe(6);
  });

  it('does not repeat an identical reason', () => {
    const merged = mergeCandidates([[candidate('a', 1, 'weekly')], [candidate('a', 1, 'weekly')]]);
    expect(merged[0].reason).toBe('weekly');
  });
});
