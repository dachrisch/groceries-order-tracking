/**
 * Plan a shopping list from text lines: search the store catalogue per line, let
 * opencode pick among those candidates, and fall back to the deterministic score when
 * it cannot answer. No writes happen here, so the plan can be previewed and corrected
 * before anything reaches the EASY Shopper list.
 */
import { EasyShopperClient, type EasyShopperSession, type SearchProduct } from './client';
import { chooseWithModel, type LineCandidates } from './choose';
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
  /** Who chose the product: opencode, or the deterministic scorer. */
  chooser: 'model' | 'rules';
}

export interface PlannedList {
  storeGuid: string;
  lines: PlannedLine[];
  matched: number;
  unmatched: number;
  /** `model` when at least one line was chosen by opencode. */
  source: 'model' | 'rules';
}

function productKey(product: SearchProduct): string {
  const candidate = toCandidate(product);
  return candidate ? `${candidate.id ?? ''}|${candidate.name}` : JSON.stringify(product).slice(0, 120);
}

/** Search once per distinct line; the caller decides who picks the product. */
export async function searchListCandidates(
  client: EasyShopperClient,
  session: EasyShopperSession,
  input: PlanInput
): Promise<LineCandidates[]> {
  const parsed = input.lines.map((raw) => parseListLine(raw)).filter((line): line is ListLine => line !== null);
  const extra = input.extraCandidates ?? [];
  const entries: LineCandidates[] = [];

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
    entries.push({ line, candidates: [...candidates, ...extra] });
  }
  return entries;
}

/** Deterministic plan from candidate pools. */
export function buildPlan(entries: LineCandidates[], storeGuid: string): PlannedList {
  const lines: PlannedLine[] = entries.map((entry) => {
    const [match] = matchLines([entry.line], entry.candidates);
    return {
      line: entry.line,
      match: match ?? { line: entry.line, candidate: null, score: 0, reason: 'no candidates', alternatives: [] },
      action: match?.candidate ? 'product' : 'text',
      chooser: 'rules',
    };
  });
  const matched = lines.filter((entry) => entry.action === 'product').length;
  return { storeGuid, lines, matched, unmatched: lines.length - matched, source: 'rules' };
}

/** Let opencode choose among the candidates we fetched; never outside them. */
export function applyPicks(
  plan: PlannedList,
  entries: LineCandidates[],
  picks: Array<number | null>
): PlannedList {
  const lines = plan.lines.map((entry, index) => {
    const pick = picks[index];
    // The candidate object always comes from the pool this backend fetched. A pick the
    // model made up, or one that points past the list it was given, has no candidate here.
    const candidate = pick === null || pick === undefined ? undefined : entries[index]?.candidates[pick];
    if (!candidate) return entry;

    const rules = scoreCandidate(entry.line.text, candidate);
    return {
      ...entry,
      match: {
        line: entry.line,
        candidate,
        score: Number(rules.score.toFixed(3)),
        reason: `opencode pick (rules: ${rules.reason})`,
        alternatives: entry.match.alternatives,
      },
      action: 'product' as const,
      chooser: 'model' as const,
    };
  });
  const matched = lines.filter((entry) => entry.action === 'product').length;
  const source = lines.some((entry) => entry.chooser === 'model') ? 'model' : 'rules';
  return { ...plan, lines, matched, unmatched: lines.length - matched, source };
}

export interface PlanOptions {
  /** Ask opencode to choose among the candidates. Default true. */
  useModel?: boolean;
}

/** Search, then let opencode pick, then keep the rules result if it could not. */
export async function planShoppingList(
  client: EasyShopperClient,
  session: EasyShopperSession,
  input: PlanInput,
  options: PlanOptions = {}
): Promise<PlannedList> {
  const entries = await searchListCandidates(client, session, input);
  const plan = buildPlan(entries, input.storeGuid);
  if (options.useModel === false) return plan;

  try {
    return applyPicks(plan, entries, await chooseWithModel(entries));
  } catch (err) {
    console.warn(
      '[easyshopper] opencode matching unavailable, using the rules score:',
      err instanceof Error ? err.message : err
    );
    return plan;
  }
}

/**
 * Re-rank a plan against items the user actually bought before. A previous in-store
 * purchase is the strongest signal for "this is the exact product I mean".
 */
export function rerankWithHistory(plan: PlannedList, recent: MatchCandidate[]): PlannedList {
  const lines = plan.lines.map((entry) => {
    // A deliberate model pick is not second-guessed by history; only the rule score is
    // an approximation that history may correct.
    if (entry.chooser === 'model') return entry;
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
