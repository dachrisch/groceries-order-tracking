/**
 * Plan a shopping list from text lines: search the store catalogue per line, then
 * match deterministically. No writes happen here, so the plan can be previewed and
 * corrected before anything reaches the EASY Shopper list.
 */
import { EasyShopperClient, type EasyShopperSession, type SearchProduct } from './client';
import { matchLines, parseListLine, scoreCandidate, toCandidate, type LineMatch, type ListLine, type MatchCandidate } from './match';

export interface PlanInput {
  lines: string[];
  storeGuid: string;
  userGuid?: string;
  /** Extra catalogue products to consider (e.g. recently bought items). */
  extraCandidates?: MatchCandidate[];
  /** Attributes passed to search, e.g. `organic`. */
  attributes?: string[];
}

export interface PlannedLine {
  line: ListLine;
  match: LineMatch;
  /** `product` = add the matched catalogue product; `text` = add as a free-text row. */
  action: 'product' | 'text';
}

export interface PlannedList {
  storeGuid: string;
  lines: PlannedLine[];
  matched: number;
  unmatched: number;
}

function productKey(product: SearchProduct): string {
  const candidate = toCandidate(product);
  return candidate ? `${candidate.id ?? ''}|${candidate.name}` : JSON.stringify(product).slice(0, 120);
}

/** Search once per distinct line and keep the best candidates for scoring. */
export async function planShoppingList(
  client: EasyShopperClient,
  session: EasyShopperSession,
  input: PlanInput
): Promise<PlannedList> {
  const parsed = input.lines
    .map((raw) => parseListLine(raw))
    .filter((line): line is ListLine => line !== null);

  const extra = input.extraCandidates ?? [];
  const planned: PlannedLine[] = [];

  for (const line of parsed) {
    let candidates: MatchCandidate[] = [];
    try {
      const response = await client.searchProducts(session.token, {
        queryText: line.text,
        storeGuid: input.storeGuid,
        userGuid: input.userGuid ?? session.userGuid,
        attributes: input.attributes,
      });
      const seen = new Set<string>();
      candidates = response.items
        .map((item) => toCandidate(item))
        .filter((candidate): candidate is MatchCandidate => candidate !== null)
        .filter((candidate) => {
          const key = productKey({ name: candidate.name, id: candidate.id });
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    } catch {
      // A failed search must not lose the line: it is planned as free text instead.
      candidates = [];
    }

    const pool = [...candidates, ...extra];
    const [match] = matchLines([line], pool);
    planned.push({
      line,
      match: match ?? {
        line,
        candidate: null,
        score: 0,
        reason: 'no candidates',
        alternatives: [],
      },
      action: match?.candidate ? 'product' : 'text',
    });
  }

  const matched = planned.filter((entry) => entry.action === 'product').length;
  return {
    storeGuid: input.storeGuid,
    lines: planned,
    matched,
    unmatched: planned.length - matched,
  };
}

/**
 * Re-rank a plan against items the user actually bought before. A previous in-store
 * purchase is the strongest signal for "this is the exact product I mean".
 */
export function rerankWithHistory(plan: PlannedList, recent: MatchCandidate[]): PlannedList {
  const lines = plan.lines.map((entry) => {
    if (entry.match.candidate && entry.match.score >= 0.8) return entry;
    const againstHistory = recent
      .map((candidate) => ({ candidate, ...scoreCandidate(entry.line.text, candidate) }))
      .sort((a, b) => b.score - a.score)[0];
    if (!againstHistory || againstHistory.score <= entry.match.score) return entry;
    return {
      ...entry,
      match: {
        ...entry.match,
        candidate: againstHistory.candidate,
        score: Number(againstHistory.score.toFixed(3)),
        reason: `${againstHistory.reason}, bought before`,
      },
      action: 'product' as const,
    };
  });
  const matched = lines.filter((entry) => entry.action === 'product').length;
  return { ...plan, lines, matched, unmatched: lines.length - matched };
}
