import { describe, it, expect } from 'vitest';
import {
  buildProductGroups,
  nameSimilarity,
  normalizeName,
  parseSize,
  sizeCompatible,
  type ProductMeta,
} from '../bot/product-groups';

const milkCategory = [{ id: 1, name: 'Milch', slug: 'milch', level: 2 }];

function product(id: number, name: string, textualAmount: string): ProductMeta {
  return { id, name, textualAmount, categories: milkCategory };
}

describe('parseSize', () => {
  it('normalizes litres, grams and multipacks', () => {
    expect(parseSize('1l')).toEqual({ value: 1000, unit: 'ml' });
    expect(parseSize('500 g')).toEqual({ value: 500, unit: 'g' });
    expect(parseSize('1,5 kg')).toEqual({ value: 1500, unit: 'g' });
    expect(parseSize('6x0,33l')).toEqual({ value: 1980, unit: 'ml' });
  });

  it('returns null when there is no amount', () => {
    expect(parseSize('Bund')).toBeNull();
    expect(parseSize(undefined)).toBeNull();
  });
});

describe('normalizeName', () => {
  it('removes brand, percentage, size and packaging noise', () => {
    expect(normalizeName('Bio Vollmilch 3,5% 1l').normalized).toBe('vollmilch');
    expect(normalizeName('Knuspr Vollmilch 1l').normalized).toBe('vollmilch');
  });

  it('keeps meaningful product words', () => {
    expect(normalizeName('Weidemilch 1l').normalized).toBe('weidemilch');
    expect(normalizeName('Hafermilch 1l').normalized).toBe('hafermilch');
  });
});

describe('sizeCompatible', () => {
  it('accepts sizes within 20 percent', () => {
    expect(sizeCompatible({ value: 1000, unit: 'ml' }, { value: 1000, unit: 'ml' })).toBe(true);
    expect(sizeCompatible({ value: 1000, unit: 'ml' }, { value: 900, unit: 'ml' })).toBe(true);
    expect(sizeCompatible({ value: 1000, unit: 'ml' }, { value: 500, unit: 'ml' })).toBe(false);
    expect(sizeCompatible({ value: 1000, unit: 'ml' }, { value: 1000, unit: 'g' })).toBe(false);
  });
});

describe('buildProductGroups', () => {
  it('groups Bio Vollmilch and Knuspr Vollmilch 1l together', () => {
    const groups = buildProductGroups([
      product(1, 'Bio Vollmilch 3,5% 1l', '1l'),
      product(2, 'Knuspr Vollmilch 1l', '1l'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].productIds).toEqual([1, 2]);
  });

  it('keeps 1l and 0,5l apart', () => {
    const groups = buildProductGroups([
      product(1, 'Vollmilch 1l', '1l'),
      product(2, 'Vollmilch 0,5l', '0,5l'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.productIds.length === 1)).toBe(true);
  });

  it('keeps Vollmilch and Hafermilch apart', () => {
    const groups = buildProductGroups([
      product(1, 'Vollmilch 1l', '1l'),
      product(2, 'Hafermilch 1l', '1l'),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('keeps a manual group exactly as it was', () => {
    const products = [
      product(1, 'Vollmilch 1l', '1l'),
      product(2, 'Knuspr Vollmilch 1l', '1l'),
      product(3, 'Weidemilch 1l', '1l'),
    ];
    const manual = [{ key: 'manual-milk', label: 'My milk', productIds: [1, 3], manual: true }];

    const groups = buildProductGroups(products, manual);

    expect(groups.find((group) => group.key === 'manual-milk')).toEqual(manual[0]);
    // Product 2 is still grouped by rules, without the manual products.
    const ruleGroup = groups.find((group) => !group.manual);
    expect(ruleGroup?.productIds).toEqual([2]);
  });

  it('scores similar names above the 0.7 threshold', () => {
    const a = normalizeName('Bio Vollmilch 3,5% 1l');
    const b = normalizeName('Knuspr Vollmilch 1l');
    expect(nameSimilarity(a, b)).toBeGreaterThanOrEqual(0.7);
  });
});
