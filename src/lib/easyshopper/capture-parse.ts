/**
 * Pure parsing for the EASY Shopper purchase screens.
 *
 * Kept out of the adb driver so it can be unit-tested against real row text:
 *
 *   list row  : "11/13/2026, 04:50 PM, MARKTKAUF MUSTERSTADT (…), CART, €107.19"
 *   item row  : "Kneipp, Dusche 200ml Gute Laune, €2.95, €2.95 x 1"
 *   deposit   : "Leergut, -€7.95, -€7.95 x 1"     <- negative, must not be dropped
 */

export interface CapturedItem {
  brand: string | null;
  name: string;
  /** Price of one unit, from the "€2.95 x 1" cell. */
  unitPrice: number | null;
  quantity: number | null;
  /** Line total, from the right-hand "Gesamt" column. Negative for deposit returns. */
  lineTotal: number | null;
  /** True for Leergut / bottle-deposit lines: money back, not a purchase. */
  isCredit: boolean;
  /** Raw row text exactly as rendered, for audit. */
  raw: string;
}

export interface CapturedSession {
  /** Stable synthetic key: date + store + total (the list row carries no id). */
  key: string;
  /** Date exactly as the screen renders it, used to confirm the detail screen changed. */
  displayWhen: string;
  purchasedAt: string;
  store: string;
  type: string;
  total: number;
  paymentMode: string | null;
  receiptBarcode: string | null;
  itemCount: number | null;
  items: CapturedItem[];
  /** Whether the item rows add up to the receipt header. */
  reconciled: boolean;
  /** `Σ lineTotal − TOTAL`; non-zero means a row was not rendered or not parsed. */
  difference: number;
}

/** The subset of a UI node the parsers need. */
export interface UiCell {
  text: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Money string -> number. Handles "-€7.95", "1.234,56" and "1,234.56". */
export function parseMoney(raw: string): number | null {
  const negative = raw.trim().startsWith('-') || /-\s*€/.test(raw);
  const cleaned = raw.replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalised: string;
  if (lastComma > -1 && lastDot > -1) {
    normalised = lastComma > lastDot ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned.replace(/,/g, '');
  } else if (lastComma > -1) {
    normalised = /,\d{2}$/.test(cleaned) ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  } else {
    normalised = cleaned;
  }
  const value = Number.parseFloat(normalised.replace(/(?!^)-/g, ''));
  if (!Number.isFinite(value)) return null;
  return negative ? -Math.abs(value) : value;
}

export const LIST_ROW = /^(\d{1,2}\/\d{1,2}\/\d{4}), (\d{1,2}:\d{2} [AP]M), (.*), ([A-Z][A-Z ]*[A-Z]), (-?€ ?[\d.,]+)$/;
export const ITEM_ROW = /^(.*), (-?€ ?[\d.,]+), (-?€ ?[\d.,]+) x ([\d.,]+)$/;
const QTY_CELL = /^-?€ ?[\d.,]+ x [\d.,]+$/;

export function toIso(datePart: string, timePart: string): string {
  const [month, day, year] = datePart.split('/').map(Number);
  const clock = /(\d{1,2}):(\d{2}) (AM|PM)/.exec(timePart);
  let hour = clock ? Number(clock[1]) : 0;
  const minute = clock ? Number(clock[2]) : 0;
  if (clock && clock[3] === 'PM' && hour < 12) hour += 12;
  if (clock && clock[3] === 'AM' && hour === 12) hour = 0;
  const date = new Date(year, month - 1, day, hour, minute);
  if (Number.isNaN(date.getTime())) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  }
  return date.toISOString();
}

export function titleCase(value: string): string {
  const capitalise = (text: string) =>
    text.replace(/(^|[\s(-])([a-zäöüß])/g, (_match, separator: string, letter: string) => separator + letter.toUpperCase());
  return capitalise(value.toLowerCase()).replace(/\(([^)]*)\)/g, (_whole, inner: string) => `(${inner.toUpperCase()})`);
}

export function parseListRow(
  desc: string
): Omit<CapturedSession, 'paymentMode' | 'receiptBarcode' | 'itemCount' | 'items' | 'reconciled' | 'difference'> | null {
  const m = LIST_ROW.exec(desc);
  if (!m) return null;
  const total = parseMoney(m[5]);
  if (total === null) return null;
  return {
    key: `${m[1]} ${m[2]}|${m[3]}|${total.toFixed(2)}`,
    displayWhen: `${m[1]}, ${m[2]}`,
    purchasedAt: toIso(m[1], m[2]),
    store: titleCase(m[3]),
    type: m[4].trim(),
    total,
  };
}

/**
 * Item rows carry brand and product as separate child nodes, so prefer those over
 * splitting the aggregated description on commas (product names contain commas).
 */
export function parseItemRow(desc: string, children: UiCell[] = []): CapturedItem | null {
  const m = ITEM_ROW.exec(desc);
  if (!m) return null;
  const lineTotal = parseMoney(m[2]);
  const unitPrice = parseMoney(m[3]);
  const quantity = Number.parseFloat(m[4].replace(',', '.'));

  const inner = children.filter((cell) => cell.text && cell.text !== desc);
  const priceCells = new Set(inner.filter((cell) => /^-?€ ?[\d.,]+$/.test(cell.text)).map((cell) => cell.text));
  const labels = inner
    .filter((cell) => !QTY_CELL.test(cell.text) && !priceCells.has(cell.text))
    .sort((p, q) => p.y1 - q.y1 || p.x1 - q.x1);

  let brand: string | null = null;
  let name = m[1];
  if (labels.length >= 2) {
    brand = labels[0].text;
    name = labels.slice(1).map((cell) => cell.text).join(' ');
  } else if (labels.length === 1) {
    name = labels[0].text;
  } else {
    const comma = m[1].indexOf(', ');
    brand = comma > 0 ? m[1].slice(0, comma) : null;
    name = comma > 0 ? m[1].slice(comma + 2) : m[1];
  }

  return {
    brand,
    name,
    unitPrice,
    quantity: Number.isFinite(quantity) ? quantity : null,
    lineTotal,
    isCredit: lineTotal !== null && lineTotal < 0,
    raw: desc,
  };
}

/**
 * Merge a fresh scan into a previous capture. A re-scan knows the session list before
 * it has read any receipts, so a failed/aborted run must never erase items that were
 * already captured — newly captured sessions win, otherwise the old one is kept.
 */
export function mergeSessions(previous: CapturedSession[], next: CapturedSession[]): CapturedSession[] {
  const byKey = new Map<string, CapturedSession>();
  for (const session of previous) byKey.set(session.key, session);
  for (const session of next) {
    const old = byKey.get(session.key);
    if (!old) {
      byKey.set(session.key, session);
      continue;
    }
    byKey.set(session.key, session.items.length >= old.items.length ? session : old);
  }
  return [...byKey.values()].sort((a, b) => (a.purchasedAt < b.purchasedAt ? 1 : -1));
}

/** Cells fully contained in a row's bounds, i.e. that row's brand/name/quantity cells. */
export function childrenOf(row: UiCell, cells: UiCell[]): UiCell[] {
  return cells.filter(
    (cell) =>
      cell !== row &&
      cell.x1 >= row.x1 - 2 &&
      cell.x2 <= row.x2 + 2 &&
      cell.y1 >= row.y1 - 2 &&
      cell.y2 <= row.y2 + 2
  );
}

/** Value rendered directly beneath a label (tolerates duplicated accessibility labels). */
export function valueBelow(cells: UiCell[], label: string, maxXOffset = 220): string | null {
  const labels = cells.filter((cell) => cell.text === label);
  if (labels.length === 0) return null;
  const anchor = labels[labels.length - 1];
  return (
    cells
      .filter((cell) => cell.y1 > anchor.y1 && cell.text && cell.text !== label && Math.abs(cell.x1 - anchor.x1) < maxXOffset)
      .sort((p, q) => p.y1 - q.y1)[0]?.text ?? null
  );
}

/**
 * First cell below a label matching a shape, regardless of horizontal position.
 * Needed for the receipt barcode, which is centred rather than left-aligned.
 */
export function valueBelowMatching(
  cells: UiCell[],
  label: string,
  test: (text: string) => boolean,
  maxGap = 520
): string | null {
  const labels = cells.filter((cell) => cell.text === label);
  if (labels.length === 0) return null;
  const anchor = labels[labels.length - 1];
  return (
    cells
      .filter((cell) => cell.y1 > anchor.y1 && cell.y1 - anchor.y1 < maxGap && test(cell.text))
      .sort((p, q) => p.y1 - q.y1)[0]?.text ?? null
  );
}

export interface Reconciliation {
  itemUnits: number;
  expectedUnits: number | null;
  itemsSum: number;
  total: number;
  difference: number;
  reconciled: boolean;
}

/**
 * Check a captured session against its own header. The header is authoritative: a
 * receipt whose rows do not add up is still worth keeping, but the discrepancy must be
 * recorded rather than hidden (discounts and weighted goods can render without a
 * matching row).
 */
export function reconcile(items: CapturedItem[], unitCount: number | null, total: number): Reconciliation {
  const itemUnits = items.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
  const itemsSum = Number(items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0).toFixed(2));
  const difference = Number((itemsSum - total).toFixed(2));
  const unitsMatch = unitCount === null || itemUnits === unitCount;
  return {
    itemUnits,
    expectedUnits: unitCount,
    itemsSum,
    total,
    difference,
    reconciled: unitsMatch && Math.abs(difference) <= 0.02,
  };
}
