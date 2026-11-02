import { describe, it, expect } from 'vitest';
import type { Purchase } from '../bot/consumption';
import {
  chooseRecipeVariant,
  normalizeRecipeVariants,
  recipeItems,
  summarizeGroups,
  type GroupStat,
} from '../bot/recipes';

let orderSeq = 1;
function bought(groupKey: string, label: string, times: number, packSize = 1000, packUnit: 'g' | 'ml' | 'piece' = 'g'): Purchase[] {
  const productId = [...groupKey].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 100000, 7);
  return Array.from({ length: times }, (_, index) => ({
    orderId: orderSeq++,
    productId,
    date: new Date(2026, 9, 1 + index * 3),
    amount: 1,
    packSize,
    packUnit,
    unitPrice: 1.5,
    name: `${label} product`,
    groupKey,
    groupLabel: label,
    groupProductIds: [productId],
  }));
}

function groupsFrom(...lists: Purchase[][]): GroupStat[] {
  return summarizeGroups(lists.flat());
}

const pizzaReply = (indexOf: (label: string) => number | null) => ({
  variants: [
    {
      style: 'homemade',
      ingredients: [
        { ingredient: 'flour', qtyPerServing: 125, unit: 'g', core: true, match: indexOf('Weizenmehl') },
        { ingredient: 'yeast', qtyPerServing: 4, unit: 'g', core: true, match: indexOf('Hefe') },
        { ingredient: 'mozzarella', qtyPerServing: 60, unit: 'g', core: true, match: indexOf('Mozzarella') },
        { ingredient: 'passata', qtyPerServing: 50, unit: 'g', core: true, match: indexOf('Passata') },
        { ingredient: 'basil', qtyPerServing: 2, unit: 'g', core: false, match: null },
      ],
    },
    {
      style: 'ready-made',
      ingredients: [{ ingredient: 'frozen pizza', qtyPerServing: 0.5, unit: 'piece', core: true, match: indexOf('Tiefkühlpizza') }],
    },
  ],
});

describe('summarizeGroups', () => {
  it('counts purchases per group and keeps pack size and unit', () => {
    const groups = groupsFrom(bought('mehl', 'Weizenmehl', 5), bought('hefe', 'Hefe', 2, 42));
    const flour = groups.find((group) => group.key === 'mehl')!;
    expect(flour.purchaseCount).toBe(5);
    expect(flour.packSize).toBe(1000);
    expect(flour.packUnit).toBe('g');
    expect(groups[0].key).toBe('mehl'); // most bought first
  });
});

describe('normalizeRecipeVariants', () => {
  it('drops match indices that are not in the list sent to the model', () => {
    const variants = normalizeRecipeVariants(
      { variants: [{ style: 'homemade', ingredients: [
        { ingredient: 'flour', qtyPerServing: 100, unit: 'g', core: true, match: 0 },
        { ingredient: 'unicorn', qtyPerServing: 1, unit: 'piece', core: true, match: 99 },
        { ingredient: 'salt', qtyPerServing: 1, unit: 'g', core: true, match: 1.5 },
      ] }] },
      2
    );
    expect(variants[0].ingredients.map((ingredient) => ingredient.match)).toEqual([0, null, null]);
  });

  it('drops ingredients without a usable quantity and unknown styles', () => {
    const variants = normalizeRecipeVariants(
      { variants: [
        { style: 'homemade', ingredients: [{ ingredient: 'flour', qtyPerServing: -1, unit: 'g', match: 0 }, { ingredient: 'yeast', qtyPerServing: 4, unit: 'g', match: 0 }] },
        { style: 'teleported', ingredients: [{ ingredient: 'x', qtyPerServing: 1, unit: 'g', match: 0 }] },
      ] },
      1
    );
    expect(variants).toHaveLength(1);
    expect(variants[0].ingredients.map((ingredient) => ingredient.ingredient)).toEqual(['yeast']);
    expect(variants[0].ingredients[0].core).toBe(true); // default
  });

  it('returns nothing for garbage', () => {
    expect(normalizeRecipeVariants('nope', 3)).toEqual([]);
    expect(normalizeRecipeVariants({ variants: 'x' }, 3)).toEqual([]);
  });
});

describe('chooseRecipeVariant', () => {
  it('picks homemade when yeast, flour and mozzarella were bought regularly', () => {
    const groups = groupsFrom(
      bought('mehl', 'Weizenmehl', 8),
      bought('hefe', 'Hefe', 5, 42),
      bought('mozz', 'Mozzarella', 11, 125),
      bought('tk', 'Tiefkühlpizza', 1, 1, 'piece'),
    );
    const indexOf = (label: string) => {
      const index = groups.findIndex((group) => group.label === label);
      return index === -1 ? null : index;
    };
    const choice = chooseRecipeVariant(normalizeRecipeVariants(pizzaReply(indexOf), groups.length), groups)!;
    expect(choice.style).toBe('homemade');
    expect(choice.evidence.map((group) => group.label).sort()).toEqual(['Hefe', 'Mozzarella', 'Weizenmehl']);
    expect(choice.missing).toEqual(['passata']);
    expect(choice.coverage).toBeCloseTo(0.75);
  });

  it('picks ready-made when only frozen pizza was ever bought', () => {
    const groups = groupsFrom(bought('tk', 'Tiefkühlpizza', 6, 1, 'piece'), bought('mehl', 'Weizenmehl', 1));
    const indexOf = (label: string) => {
      const index = groups.findIndex((group) => group.label === label);
      return index === -1 ? null : index;
    };
    const choice = chooseRecipeVariant(normalizeRecipeVariants(pizzaReply(indexOf), groups.length), groups)!;
    expect(choice.style).toBe('ready-made');
    expect(choice.missing).toEqual([]);
  });

  it('does not call it homemade on one-off ingredient purchases', () => {
    const groups = groupsFrom(bought('mehl', 'Weizenmehl', 1), bought('hefe', 'Hefe', 1, 42), bought('mozz', 'Mozzarella', 1, 125));
    const indexOf = (label: string) => {
      const index = groups.findIndex((group) => group.label === label);
      return index === -1 ? null : index;
    };
    const choice = chooseRecipeVariant(normalizeRecipeVariants(pizzaReply(indexOf), groups.length), groups)!;
    // Coverage is fine but there is no evidence of regular buying; still the best-covered variant.
    expect(choice.style).toBe('homemade');
    expect(choice.confident).toBe(false);
  });

  it('returns null when nothing matches at all', () => {
    const groups = groupsFrom(bought('milch', 'Milch', 5));
    const choice = chooseRecipeVariant(normalizeRecipeVariants(pizzaReply(() => null), groups.length), groups);
    expect(choice).toBeNull();
  });
});

describe('recipeItems', () => {
  it('converts grams per serving into the group pack size and keeps the usual product', () => {
    const groups = groupsFrom(bought('mehl', 'Weizenmehl', 8), bought('hefe', 'Hefe', 5, 42), bought('mozz', 'Mozzarella', 11, 125));
    const indexOf = (label: string) => {
      const index = groups.findIndex((group) => group.label === label);
      return index === -1 ? null : index;
    };
    const choice = chooseRecipeVariant(normalizeRecipeVariants(pizzaReply(indexOf), groups.length), groups)!;
    const items = recipeItems(choice.variant, groups);
    const mozz = items.find((item) => item.groupKey === 'mozz')!;
    expect(mozz.qtyPerServing).toBe(60);
    expect(mozz.packSize).toBe(125);
    expect(mozz.core).toBe(true);
    expect(mozz.productId).toBe(groups.find((group) => group.key === 'mozz')!.productId);
    expect(items.some((item) => item.name.toLowerCase().includes('basil'))).toBe(false);
  });

  it('counts pieces as packs when the product has no weight', () => {
    const groups = groupsFrom(bought('tk', 'Tiefkühlpizza', 6, 1, 'piece'));
    const variants = normalizeRecipeVariants(
      { variants: [{ style: 'ready-made', ingredients: [{ ingredient: 'frozen pizza', qtyPerServing: 0.5, unit: 'piece', match: 0 }] }] },
      1
    );
    const [item] = recipeItems(variants[0], groups);
    expect(item.qtyPerServing).toBe(0.5);
    expect(item.packSize).toBe(1);
  });

  it('falls back to a quarter pack per person when units do not match', () => {
    const groups = groupsFrom(bought('basil', 'Basilikum', 3, 1, 'piece'));
    const variants = normalizeRecipeVariants(
      { variants: [{ style: 'homemade', ingredients: [{ ingredient: 'basil', qtyPerServing: 2, unit: 'g', match: 0 }] }] },
      1
    );
    const [item] = recipeItems(variants[0], groups);
    expect(item.qtyPerServing).toBe(0.25);
    expect(item.packSize).toBe(1);
  });
});
