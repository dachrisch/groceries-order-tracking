/**
 * The cross-store display link: "you also buy this at EDEKA".
 *
 * Purely presentational. Nothing in this file reads the database, and nothing it
 * returns is allowed to travel back into the learning pipeline — the link must
 * not move a weekly rate, a stock estimate, a "due" flag or an occasion. It only
 * tells the product list that one EDEKA row belongs next to a Knuspr product
 * instead of standing on its own.
 *
 * Two mechanisms, deliberately separate:
 *  - a manual row (`models/ProductLink`) is the shopper's own correction and
 *    always wins, confidence 1;
 *  - an automatic match is computed here on every read and never stored, so it
 *    disappears the moment the receipts no longer support it.
 */
import {
  nameSimilarity,
  normalizeName,
  sizeCompatible,
  type ParsedProductName,
} from './bot/product-groups';

/** A Knuspr item as the product list shows it (one learned product group). */
export interface KnusprProductLike {
  /** The product the row is built from; also the key of the result map. */
  productId: number;
  name: string;
  /** Every product id the row stands for. Knuspr rotates ids inside a group. */
  productIds?: number[];
}

/** The part of an `EdekaProductAgg` this matcher needs. */
export interface EdekaBucketLike {
  textKey: string;
  name: string;
}

export interface ManualProductLink {
  knusprProductId: number;
  edekaTextKey: string;
  confidence?: number;
}

export type ProductLinkSource = 'auto' | 'manual';

export interface ResolvedProductLink {
  edekaTextKey: string;
  confidence: number;
  source: ProductLinkSource;
}

/**
 * Name similarity a pair needs before we call it the same product.
 *
 * Below this the row stays unlinked: showing the wrong EDEKA product next to a
 * Knuspr one reads as a merged habit, which is exactly what D5 forbids. The
 * shopper can still assert a link by hand, which is the escape hatch.
 */
export const LINK_SIMILARITY_FLOOR = 0.8;

/**
 * Percentages and similar figures that make two products different even though
 * their names look the same. `normalizeName` strips them, so "Vollmilch 1,5 %"
 * and "Vollmilch 3,5 %" would otherwise score as one product — which is the
 * kind of wrong link that reads as a merged habit.
 */
function figures(name: string): Set<string> {
  const found = new Set<string>();
  for (const match of name.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
    found.add(`pct:${match[1].replace(',', '.')}`);
  }
  return found;
}

/** True only when both names carry a figure and they disagree. */
function conflictingFigures(a: string, b: string): boolean {
  const left = figures(a);
  const right = figures(b);
  if (left.size === 0 || right.size === 0) return false;
  for (const figure of left) {
    if (!right.has(figure)) return true;
  }
  return false;
}

function roundConfidence(value: number): number {
  return Math.round(value * 100) / 100;
}

function idsOf(product: KnusprProductLike): number[] {
  return product.productIds?.length ? product.productIds : [product.productId];
}

interface Candidate {
  productId: number;
  textKey: string;
  confidence: number;
}

/**
 * Resolve one EDEKA bucket per Knuspr product. Every input product gets an entry,
 * `null` when nothing clears the floor.
 *
 * Assignment is greedy and exclusive: one EDEKA bucket can back only one Knuspr
 * row (and the reverse), so a near-duplicate product can never show the same
 * receipt row twice. Manual rows claim their bucket first, then automatic pairs
 * compete by similarity.
 */
export function resolveLinks(
  knusprProducts: KnusprProductLike[],
  edekaBuckets: Iterable<EdekaBucketLike>,
  manualLinks: ManualProductLink[] = []
): Map<number, ResolvedProductLink | null> {
  const resolved = new Map<number, ResolvedProductLink | null>();
  const claimedBuckets = new Set<string>();

  // A manual link may name any product of the group: the shopper points at the
  // row they see, and a later Knuspr id rotation must not drop the correction.
  const manualByProduct = new Map<number, ManualProductLink>();
  for (const manual of manualLinks) manualByProduct.set(manual.knusprProductId, manual);

  const automatic: KnusprProductLike[] = [];
  for (const product of knusprProducts) {
    const manual = idsOf(product)
      .map((id) => manualByProduct.get(id))
      .find((entry): entry is ManualProductLink => entry !== undefined);

    if (manual) {
      resolved.set(product.productId, {
        edekaTextKey: manual.edekaTextKey,
        confidence: 1,
        source: 'manual',
      });
      claimedBuckets.add(manual.edekaTextKey);
    } else {
      automatic.push(product);
    }
  }

  // Brand is intentionally left out of the comparison: EDEKA receipts keep it in
  // its own field while Knuspr folds it into the name, and `normalizeName` already
  // drops the brands both stores share. Comparing names only avoids penalising a
  // shop brand we do not know.
  const buckets: Array<{ textKey: string; name: string; parsed: ParsedProductName }> = [];
  for (const bucket of edekaBuckets) {
    if (claimedBuckets.has(bucket.textKey)) continue;
    buckets.push({ textKey: bucket.textKey, name: bucket.name, parsed: normalizeName(bucket.name) });
  }

  const candidates: Candidate[] = [];
  for (const product of automatic) {
    const parsed = normalizeName(product.name);
    for (const bucket of buckets) {
      if (!sizeCompatible(parsed.size, bucket.parsed.size)) continue;
      if (conflictingFigures(product.name, bucket.name)) continue;
      const similarity = nameSimilarity(parsed, bucket.parsed);
      if (similarity < LINK_SIMILARITY_FLOOR) continue;
      candidates.push({
        productId: product.productId,
        textKey: bucket.textKey,
        confidence: roundConfidence(similarity),
      });
    }
  }

  // Strongest pair first; the tie-breaks only exist so a read is deterministic.
  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.textKey.localeCompare(b.textKey) ||
      a.productId - b.productId
  );

  const assigned = new Set<number>();
  for (const candidate of candidates) {
    if (assigned.has(candidate.productId) || claimedBuckets.has(candidate.textKey)) continue;
    assigned.add(candidate.productId);
    claimedBuckets.add(candidate.textKey);
    resolved.set(candidate.productId, {
      edekaTextKey: candidate.textKey,
      confidence: candidate.confidence,
      source: 'auto',
    });
  }

  for (const product of knusprProducts) {
    if (!resolved.has(product.productId)) resolved.set(product.productId, null);
  }

  return resolved;
}
