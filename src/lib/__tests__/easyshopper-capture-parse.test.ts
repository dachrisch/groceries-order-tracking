import { describe, it, expect } from 'vitest';
import { decodeEntities, mergeSessions, parseItemRow, parseListRow, parseMoney, reconcile, titleCase, toIso, valueBelow, valueBelowMatching } from '../easyshopper/capture-parse';

describe('parseMoney', () => {
  it('reads euro amounts in both separators', () => {
    expect(parseMoney('€107.19')).toBe(107.19);
    expect(parseMoney('1.234,56')).toBe(1234.56);
    expect(parseMoney('€0,99')).toBe(0.99);
  });

  it('keeps deposit returns negative', () => {
    expect(parseMoney('-€7.95')).toBe(-7.95);
    expect(parseMoney('-€7,95')).toBe(-7.95);
  });

  it('rejects junk', () => {
    expect(parseMoney('—')).toBeNull();
  });
});

describe('parseListRow', () => {
  it('splits the aggregated row description', () => {
    const row = parseListRow('11/13/2026, 04:50 PM, EDEKA MUSTERSTADT (MUSTERSTR.), CART, €107.19');
    expect(row).toMatchObject({
      displayWhen: '11/13/2026, 04:50 PM',
      purchasedAt: '2026-11-13T16:50:00.000Z',
      type: 'CART',
      total: 107.19,
    });
    expect(row?.store).toContain('Musterstadt');
    expect(row?.key).toContain('107.19');
  });

  it('ignores non-row text', () => {
    expect(parseListRow('My Purchases')).toBeNull();
  });
});

describe('parseItemRow', () => {
  it('reads a deposit return instead of dropping the row', () => {
    const item = parseItemRow('Leergut, -€7.95, -€7.95 x 1');
    expect(item).toMatchObject({ name: 'Leergut', lineTotal: -7.95, isCredit: true, quantity: 1 });
  });

  it('uses child cells for brand and product name', () => {
    const item = parseItemRow(
      'Kneipp, Dusche 200ml Gute Laune, €2.95, €2.95 x 1',
      [
        { text: 'Kneipp', x1: 227, y1: 1425, x2: 873, y2: 1472 },
        { text: 'Dusche 200ml Gute Laune', x1: 227, y1: 1472, x2: 873, y2: 1519 },
        { text: '€2.95', x1: 951, y1: 1449, x2: 1040, y2: 1496 },
        { text: '€2.95 x 1', x1: 227, y1: 1555, x2: 380, y2: 1602 },
      ]
    );
    expect(item).toMatchObject({
      brand: 'Kneipp',
      name: 'Dusche 200ml Gute Laune',
      unitPrice: 2.95,
      lineTotal: 2.95,
      quantity: 1,
      isCredit: false,
    });
  });

  it('handles a row without a brand', () => {
    expect(parseItemRow('Zitronen klein, €0.99, €0.99 x 1')?.name).toBe('Zitronen klein');
  });

  it('keeps multipack quantities', () => {
    const item = parseItemRow('Italien, 12 e mezzo Negroamaro IGP0,75l, €23.97, €7.99 x 3');
    expect(item).toMatchObject({ lineTotal: 23.97, unitPrice: 7.99, quantity: 3 });
  });
});

describe('titleCase', () => {
  it('uppercases the street in brackets only', () => {
    expect(titleCase('EDEKA MUSTERSTADT (MUSTERSTR.)')).toBe(
      'Edeka Musterstadt (MUSTERSTR.)'
    );
  });
});

describe('toIso', () => {
  it('converts the 12-hour clock', () => {
    // Wall clock as UTC: no dependency on the machine's timezone.
    expect(toIso('11/13/2026', '04:50 PM')).toBe('2026-11-13T16:50:00.000Z');
    expect(toIso('12/30/2025', '12:58 PM')).toBe('2025-12-30T12:58:00.000Z');
    expect(toIso('01/02/2026', '12:05 AM')).toBe('2026-01-02T00:05:00.000Z');
  });
});

describe('mergeSessions', () => {
  const session = (key: string, items: number, purchasedAt: string) => ({
    key,
    displayWhen: '',
    purchasedAt,
    store: 'S',
    type: 'CART',
    total: 1,
    paymentMode: null,
    receiptBarcode: null,
    itemCount: items,
    items: Array.from({ length: items }, () => ({
      brand: null,
      name: 'x',
      unitPrice: 1,
      quantity: 1,
      lineTotal: 1,
      isCredit: false,
      raw: 'x',
    })),
  });

  it('keeps receipts captured by an earlier run when a re-scan is empty', () => {
    const previous = [session('a', 3, '2026-01-02T00:00:00.000Z')];
    const next = [session('a', 0, '2026-01-02T00:00:00.000Z')];
    expect(mergeSessions(previous, next)[0].items).toHaveLength(3);
  });

  it('prefers a more complete capture and keeps sessions missing from the re-scan', () => {
    const previous = [session('a', 3, '2026-01-02T00:00:00.000Z')];
    const next = [session('a', 5, '2026-01-02T00:00:00.000Z'), session('b', 2, '2026-02-02T00:00:00.000Z')];
    const merged = mergeSessions(previous, next);
    expect(merged).toHaveLength(2);
    expect(merged.find((entry) => entry.key === 'a')?.items).toHaveLength(5);
  });

  it('sorts newest first', () => {
    const merged = mergeSessions([], [session('old', 1, '2025-01-01T00:00:00.000Z'), session('new', 1, '2026-01-01T00:00:00.000Z')]);
    expect(merged[0].key).toBe('new');
  });
});

describe('valueBelow', () => {
  const cell = (text: string, x: number, y: number) => ({ text, x1: x, y1: y, x2: x + 200, y2: y + 40 });

  it('picks the value under a duplicated label', () => {
    const cells = [cell('Store', 73, 536), cell('Store', 73, 556), cell('Marktkauf Musterstadt', 73, 636)];
    expect(valueBelow(cells, 'Store')).toBe('Marktkauf Musterstadt');
  });

  it('finds a centred value regardless of x', () => {
    const cells = [cell('Receipt Barcode', 73, 870), cell('0012345678901234567890', 320, 1177)];
    expect(valueBelowMatching(cells, 'Receipt Barcode', (text) => /^\d{8,}$/.test(text))).toBe('0012345678901234567890');
  });

  it('returns null when the label is absent', () => {
    expect(valueBelow([cell('Other', 0, 0)], 'Store')).toBeNull();
  });
});

describe('reconcile', () => {
  const item = (lineTotal: number, quantity = 1) => ({
    brand: null,
    name: 'x',
    unitPrice: lineTotal,
    quantity,
    lineTotal,
    isCredit: lineTotal < 0,
    raw: 'x',
  });

  it('accepts a receipt whose rows add up', () => {
    const check = reconcile([item(2.95), item(5.45)], 2, 8.4);
    expect(check.reconciled).toBe(true);
    expect(check.difference).toBe(0);
  });

  it('counts units, not rows', () => {
    const check = reconcile([item(23.97, 3), item(0.99)], 4, 24.96);
    expect(check.itemUnits).toBe(4);
    expect(check.reconciled).toBe(true);
  });

  it('flags a missing row and keeps the difference', () => {
    const check = reconcile([item(2.95)], 2, 3.79);
    expect(check.reconciled).toBe(false);
    expect(check.difference).toBe(-0.84);
  });

  it('treats deposit returns as negative rows', () => {
    const check = reconcile([item(24.91), item(-7.95)], 2, 16.96);
    expect(check.reconciled).toBe(true);
  });
});

describe('decodeEntities', () => {
  it('decodes the entities the dump emits', () => {
    expect(decodeEntities('Gut &amp; Günstig')).toBe('Gut & Günstig');
    expect(decodeEntities('&quot;Bio&quot; Milch')).toBe('"Bio" Milch');
  });

  it('does not double-unescape', () => {
    // The app escaped the text once; "&amp;lt;" is a literal "&lt;", not "<".
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});
