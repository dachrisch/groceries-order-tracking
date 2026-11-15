/**
 * Plan a shopping list from text lines: search the store catalogue per line, let
 * opencode pick among those candidates, and fall back to the deterministic score when
 * it cannot answer. No writes happen here, so the plan can be previewed and corrected
 * before anything reaches the EASY Shopper list.
 */
import { normalizeName } from '../bot/product-groups';
import { chooseWithModel, MAX_CANDIDATES, type LineCandidates } from './choose';
import { EasyShopperClient, type EasyShopperSession, type SearchProduct } from './client';
import { matchLines, parseListLine, scoreCandidate, toCandidate, type LineMatch, type ListLine, type MatchCandidate } from './match';
import { isOpencodeConfigured } from '../opencode-client';

export interface PlanInput {
  lines: string[];
  storeGuid: string;
  userGuid?: string;
  /**
   * Recent purchases, offered to the model as extra menu rows. Rows that duplicate a
   * catalogue item are dropped, so a pick always keeps the catalogue's id and price.
   */
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

/**
 * Who a candidate *is*, however it reached us: a history row and a catalogue item for
 * the same product must collapse to one menu row. A catalogue name often repeats its
 * brand, so that repetition is stripped before comparing.
 */
function candidateKey(candidate: MatchCandidate): string {
  const brand = normalizeName(candidate.brand ?? '').normalized;
  let name = normalizeName(candidate.name).normalized;
  if (brand && name.startsWith(brand)) name = name.slice(brand.length).trim();
  return `${brand}|${name}`;
}

/**
 * Search once per list line, in input order. Identical typed lines are searched again
 * rather than merged: the plan mirrors the input row for row, and merging would silently
 * drop a row the shopper typed.
 */
export async function searchListCandidates(
  client: EasyShopperClient,
  session: EasyShopperSession,
  input: PlanInput
): Promise<LineCandidates[]> {
  const parsed = input.lines.map((raw) => parseListLine(raw)).filter((line): line is ListLine => line !== null);
  const entries: LineCandidates[] = [];

  for (const line of parsed) {
    let catalogue: MatchCandidate[] = [];
    try {
      const response = await client.searchProducts(session.token, {
        queryText: line.text,
        storeGuid: input.storeGuid,
        userGuid: input.userGuid ?? session.userGuid,
        attributes: input.attributes,
      });
      const seen = new Set<string>();
      catalogue = response.items
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
      catalogue = [];
    }

    // History rows are candidates too — the model may choose them — but never a second
    // copy of a product the catalogue already lists: that copy has no id and no price.
    const known = new Set(catalogue.map(candidateKey));
    const history: MatchCandidate[] = [];
    for (const candidate of input.extraCandidates ?? []) {
      const key = candidateKey(candidate);
      if (known.has(key)) continue;
      known.add(key);
      history.push(candidate);
    }

    // One ordered menu: the model's positions, `readPicks`' bounds and `applyPicks`'
    // index all refer to this array. Best score first, so the cap keeps what matters.
    const pool = [...catalogue, ...history]
      .map((candidate) => ({ candidate, score: scoreCandidate(line.text, candidate).score }))
      .sort((a, b) => b.score - a.score || a.candidate.name.length - b.candidate.name.length)
      .slice(0, MAX_CANDIDATES)
      .map((entry) => entry.candidate);

    entries.push({ line, candidates: pool });
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
    const pool = entries[index];
    const pick = picks[index];
    // The candidate object always comes from the menu this backend built — catalogue
    // search plus recent purchases, never the model. A made-up index has nothing here,
    // and a pool that does not belong to this line cannot answer it.
    const candidate =
      pick === null || pick === undefined || pool?.line.text !== entry.line.text
        ? undefined
        : pool.candidates[pick];
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

/**
 * One pick is one cheap text call on a user-facing request: three candidate models at
 * 20 s each bound the wait at roughly a minute, instead of the whole free chain at the
 * client's default timeout.
 */
const MATCH_CALL = { timeoutMs: 20_000, maxModels: 3 } as const;

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
    return applyPicks(plan, entries, await chooseWithModel(entries, MATCH_CALL));
  } catch (err) {
    // With opencode switched off the rules plan is not a failure — planning must work
    // without it — so only a real call failure is worth a log line.
    if (isOpencodeConfigured()) {
      console.warn(
        '[easyshopper] opencode matching unavailable, using the rules score:',
        err instanceof Error ? err.message : err
      );
    }
    return plan;
  }
}

/**
 * Re-rank a plan against items the user actually bought before. Recent purchases are
 * already in the model's menu, so this only corrects a *rules* line whose score is an
 * approximation: a model pick is deliberate and is never second-guessed.
 */
export function rerankWithHistory(plan: PlannedList, recent: MatchCandidate[]): PlannedList {
  const lines = plan.lines.map((entry) => {
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
