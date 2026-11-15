/**
 * Deterministic matching of handwritten shopping-list lines to real EDEKA products.
 *
 * No LLM here: the list text is normalised with the same rules the bot uses for
 * product groups, and each line is scored against catalogue search results.
 * The LLM's only job upstream is turning a photo into lines of text.
 */
import { normalizeName, parseSize, sizeCompatible } from '../bot/product-groups';

export interface ListLine {
  text: string;
  quantity: number;
}

export interface MatchCandidate {
  /** EASY Shopper product id, when search returned one. */
  id?: string;
  gtin?: string;
  name: string;
  brand?: string | null;
  price?: number | null;
  /** The untouched object returned by /v6/searchMeta. */
  raw?: Record<string, unknown>;
}

export interface LineMatch {
  line: ListLine;
  candidate: MatchCandidate | null;
  score: number;
  /** Human-readable justification, also used as the UI's "why" column. */
  reason: string;
  alternatives: MatchCandidate[];
}

const STOPWORDS = new Set(['und', 'oder', 'mit', 'ohne', 'der', 'die', 'das', 'ein', 'eine', 'etwas', 'bitte', 'ca']);

/** Split a raw OCR/typed line into a quantity and the product text. */
export function parseListLine(raw: string): ListLine | null {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const quantityMatch = /^(\d{1,3})\s*(?:x|×|\*)\s*(.+)$/i.exec(text);
  if (quantityMatch) {
    return { text: quantityMatch[2].trim(), quantity: Number(quantityMatch[1]) };
  }
  return { text, quantity: 1 };
}

function tokensOf(text: string): string[] {
  return normalizeName(text).tokens.filter((token) => !STOPWORDS.has(token));
}

export interface MatchOptions {
  /** Minimum score (0..1) to accept a candidate. Default 0.55. */
  threshold?: number;
  /** How many alternatives to keep per line. Default 3. */
  alternatives?: number;
}

/**
 * Score one line against one candidate. Coverage of the query tokens dominates:
 * a list line is a fragment ("milch 1,5") and the product name is verbose
 * ("Weihenstephan H-Milch 1,5% 1l"), so containment matters more than symmetry.
 */
export function scoreCandidate(lineText: string, candidate: MatchCandidate): { score: number; reason: string } {
  const queryTokens = tokensOf(lineText);
  const candidateTokens = tokensOf(`${candidate.brand ?? ''} ${candidate.name}`);
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return { score: 0, reason: 'no comparable tokens' };
  }

  const candidateSet = new Set(candidateTokens);
  const matched = queryTokens.filter((token) => candidateSet.has(token));

  // Bare numbers ("1,5" without a unit) are weak evidence — a size hint, not a word.
  // They must never dilute coverage, or "Milch 1,5" would score worse than "Milch".
  const alphaQuery = queryTokens.filter((token) => /[a-z]/.test(token));
  const alphaMatched = matched.filter((token) => /[a-z]/.test(token));
  const coverage =
    alphaQuery.length > 0 ? alphaMatched.length / alphaQuery.length : matched.length / queryTokens.length;
  const union = new Set([...queryTokens, ...candidateTokens]);
  const jaccard = matched.length / union.size;

  let score = 0.65 * coverage + 0.35 * jaccard;
  const reasons: string[] = [
    alphaQuery.length > 0
      ? `${alphaMatched.length}/${alphaQuery.length} words`
      : `${matched.length}/${queryTokens.length} tokens`,
  ];

  const querySize = parseSize(lineText);
  const candidateSize = parseSize(candidate.name);
  if (querySize && candidateSize) {
    if (sizeCompatible(querySize, candidateSize)) {
      score += 0.1;
      reasons.push('size ok');
    } else {
      score -= 0.35;
      reasons.push('size mismatch');
    }
  }

  if (candidate.brand) {
    const brandTokens = tokensOf(candidate.brand);
    if (brandTokens.length > 0 && brandTokens.every((token) => queryTokens.includes(token))) {
      score += 0.05;
      reasons.push('brand named');
    }
  }

  return { score: Math.max(0, Math.min(1, score)), reason: reasons.join(', ') };
}

/** Match every line against the candidate pool, best first. */
export function matchLines(
  lines: ListLine[],
  candidates: MatchCandidate[],
  options: MatchOptions = {}
): LineMatch[] {
  const threshold = options.threshold ?? 0.55;
  const keep = options.alternatives ?? 3;

  return lines.map((line) => {
    const scored = candidates
      .map((candidate) => ({ candidate, ...scoreCandidate(line.text, candidate) }))
      .sort((a, b) => b.score - a.score || a.candidate.name.length - b.candidate.name.length);

    const best = scored[0];
    const accepted = best && best.score >= threshold ? best : null;

    return {
      line,
      candidate: accepted?.candidate ?? null,
      score: Number((accepted?.score ?? best?.score ?? 0).toFixed(3)),
      reason: accepted ? accepted.reason : `below threshold (${(best?.score ?? 0).toFixed(2)}): ${best?.candidate.name ?? 'no candidates'}`,
      alternatives: scored.slice(accepted ? 1 : 0, (accepted ? 1 : 0) + keep).map((entry) => entry.candidate),
    };
  });
}

/** Pull the fields we care about out of a raw `/v6/searchMeta` item. */
export function toCandidate(item: Record<string, unknown>): MatchCandidate | null {
  const product = (item.product as Record<string, unknown> | undefined) ?? item;
  const name = (product.name as string | undefined) ?? (item.name as string | undefined);
  if (!name) return null;
  const brand = (product.brand as string | undefined) ?? null;
  const id = (product.id ?? product.guid ?? item.id ?? item.guid) as string | number | undefined;
  const gtin = (product.gtin ?? item.gtin) as string | undefined;
  const priceValue = product.price ?? item.price;
  const price =
    typeof priceValue === 'number'
      ? priceValue
      : typeof (priceValue as { amount?: unknown } | undefined)?.amount === 'number'
        ? ((priceValue as { amount: number }).amount)
        : null;
  return {
    id: id === undefined ? undefined : String(id),
    gtin,
    name,
    brand,
    price,
    raw: item,
  };
}

/**
 * Human label for a line, e.g. "2x Milch". The text is kept exactly as the shopper
 * wrote it — umlauts included — because it is also what the model reads, and "Müsli"
 * and "Muesli" are not the same word to it.
 */
export function describeLine(line: ListLine): string {
  if (line.quantity > 1) return `${line.quantity}x ${line.text}`;
  return line.text;
}
