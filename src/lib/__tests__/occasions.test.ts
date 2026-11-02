import { describe, it, expect } from 'vitest';
import {
  buildCandidateBaskets,
  closestOccasionNames,
  findClusters,
  matchOccasion,
  occasionPacks,
  type Basket,
  type BasketItem,
} from '../bot/occasions';
import type { BuiltGroup } from '../bot/product-groups';
import type { ConsumptionItem } from '../bot/consumption';

const DAY_MS = 24 * 60 * 60 * 1000;

function group(key: string, productIds: number[]): BuiltGroup {
  return { key, label: key, productIds, manual: false };
}

function regular(groupKey: string, modeAmount = 1): ConsumptionItem {
  return { groupKey, modeAmount } as ConsumptionItem;
}

function basket(orderId: number, daysAgo: number, keys: string[]): Basket {
  const items = new Map<string, BasketItem>();
  keys.forEach((key, index) => {
    items.set(key, {
      groupKey: key,
      productId: index + 1,
      name: `${key} product`,
      units: 1,
      amount: 1,
      packSize: 1,
    });
  });
  return { orderId, date: new Date(Date.now() - daysAgo * DAY_MS), items };
}

describe('buildCandidateBaskets', () => {
  const groupByProduct = new Map<number, BuiltGroup>([
    [1, group('cheese', [1])],
    [2, group('tomato', [2])],
    [3, group('milk', [3])],
    [4, group('dough', [4])],
  ]);

  const regularByGroup = new Map<string, ConsumptionItem>([
    ['milk', regular('milk')],
    ['cheese', regular('cheese', 1)],
  ]);

  function order(id: number, items: Array<{ id: number; amount?: number }>) {
    return {
      id,
      orderTimeDate: new Date(),
      items: items.map((item) => ({ id: item.id, name: `Product ${item.id}`, amount: item.amount })),
    };
  }

  it('drops regular weekly items from an occasion basket', () => {
    const baskets = buildCandidateBaskets(
      [order(1, [{ id: 3 }, { id: 2, amount: 2 }, { id: 4 }])],
      groupByProduct,
      regularByGroup
    );

    expect(baskets).toHaveLength(1);
    expect([...baskets[0].items.keys()]).toEqual(['tomato', 'dough']);
  });

  it('keeps a regular item when the quantity is far above normal', () => {
    const baskets = buildCandidateBaskets(
      [order(2, [{ id: 1, amount: 3 }, { id: 2 }])],
      groupByProduct,
      regularByGroup
    );

    expect(baskets).toHaveLength(1);
    expect([...baskets[0].items.keys()]).toEqual(['cheese', 'tomato']);
  });

  it('ignores baskets with only one candidate item', () => {
    const baskets = buildCandidateBaskets(
      [order(3, [{ id: 3 }, { id: 4 }])],
      groupByProduct,
      regularByGroup
    );

    expect(baskets).toEqual([]);
  });
});

describe('findClusters', () => {
  it('turns three pizza baskets into one occasion', () => {
    const clusters = findClusters([
      basket(1, 21, ['cheese', 'tomato']),
      basket(2, 14, ['cheese', 'tomato']),
      basket(3, 7, ['cheese', 'tomato']),
      basket(4, 20, ['dough', 'salami']),
      basket(5, 10, ['beer', 'chips']),
      basket(6, 5, ['sushi', 'wasabi']),
    ]);

    expect(clusters).toHaveLength(1);
    expect([...clusters[0].keys].sort()).toEqual(['cheese', 'tomato']);
    expect(clusters[0].occurrences).toHaveLength(3);
  });

  it('does not cluster one-off baskets', () => {
    const clusters = findClusters([
      basket(1, 14, ['cheese', 'tomato']),
      basket(2, 7, ['dough', 'salami']),
    ]);

    expect(clusters).toEqual([]);
  });

  it('merges overlapping variants of the same occasion', () => {
    const clusters = findClusters([
      basket(1, 28, ['cheese', 'tomato', 'dough']),
      basket(2, 21, ['cheese', 'tomato', 'salami']),
      basket(3, 14, ['cheese', 'tomato', 'dough']),
      basket(4, 7, ['cheese', 'tomato', 'salami']),
      basket(5, 25, ['beer', 'chips']),
      basket(6, 18, ['sushi', 'wasabi']),
      basket(7, 11, ['curry', 'rice']),
      basket(8, 4, ['noodles', 'sauce']),
    ]);

    expect(clusters).toHaveLength(1);
    expect([...clusters[0].keys].sort()).toEqual(['cheese', 'dough', 'salami', 'tomato']);
    expect(clusters[0].occurrences).toHaveLength(4);
  });
});

describe('occasionPacks', () => {
  it('scales from 4 to 6 people', () => {
    const four = occasionPacks(0.5, 4, 1);
    const six = occasionPacks(0.5, 6, 1);

    expect(four).toBe(2);
    expect(six).toBe(3);
    expect(six / four).toBe(1.5);
  });

  it('rounds up to whole packs', () => {
    expect(occasionPacks(0.5, 6, 2)).toBe(2);
  });

  it('always buys at least one pack', () => {
    expect(occasionPacks(0.1, 2, 10)).toBe(1);
  });
});

describe('matchOccasion', () => {
  const occasions = [
    { name: 'Pizza night', aliases: ['pizza', 'movie night'] },
    { name: 'Taco Tuesday', aliases: [] },
    { name: 'Käseabend', aliases: [] },
  ];

  it('matches the exact name', () => {
    expect(matchOccasion(occasions, 'Pizza Night')).toEqual(occasions[0]);
  });

  it('matches an alias inside a longer sentence', () => {
    expect(matchOccasion(occasions, 'movie night with friends')).toEqual(occasions[0]);
  });

  it('matches words in any order', () => {
    expect(matchOccasion(occasions, 'tuesday taco')).toEqual(occasions[1]);
  });

  it('ignores umlauts', () => {
    expect(matchOccasion(occasions, 'kaseabend')).toEqual(occasions[2]);
  });

  it('returns null for an unknown occasion', () => {
    expect(matchOccasion(occasions, 'sushi evening')).toBeNull();
  });
});

describe('closestOccasionNames', () => {
  it('suggests the closest known names', () => {
    const names = closestOccasionNames(
      [{ name: 'Pizza night' }, { name: 'Taco Tuesday' }, { name: 'Käseabend' }],
      'pizza friday'
    );

    expect(names[0]).toBe('Pizza night');
  });
});
