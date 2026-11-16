/**
 * Model-assisted matching of list lines to catalogue candidates.
 *
 * The backend owns the candidate menu, so the model can only point at one of its rows
 * by position. An answer that names another product, or an index outside the list that
 * line was given, is discarded and the deterministic score stands. That is what keeps
 * "the LLM never introduces a product id" true while the model still supplies the
 * judgement a bag-of-words score cannot: "Waschmittel sensitiv" is the powder, not the
 * rinse aid, and "Milch 1,5" is not condensed milk.
 *
 * This is a text call on the free tier; only photo intake may reach a paid model. It is
 * also on a user-facing request, so the caller bounds it (`timeoutMs`, `maxModels`).
 *
 * // follow-up: skipping lines the rules already scored near-perfectly would save quota;
 * // today every plan asks once, at the cost of one free call.
 */
import { runPrompt, type RunPromptOptions } from '../opencode-client';
import { describeLine, type ListLine, type MatchCandidate } from './match';

export interface LineCandidates {
  line: ListLine;
  /**
   * The menu for this line, already ordered and capped (`searchListCandidates`): the
   * prompt, `readPicks`' validation and `applyPicks`' indexing all use this one array.
   */
  candidates: MatchCandidate[];
}

/** How many candidates one line may offer; more only dilutes the choice. */
export const MAX_CANDIDATES = 8;

/**
 * The only knobs a matcher needs. Deliberately narrower than `RunPromptOptions`, so a
 * photo path (`files`, `require: 'image'`, `allowPaid`) is unrepresentable here.
 */
export type ChooseOptions = Pick<RunPromptOptions, 'timeoutMs' | 'maxModels' | 'models'>;

/** `Brand Name`, but never `Brand Brand Name` when the catalogue already repeats it. */
function displayName(candidate: MatchCandidate): string {
  const name = candidate.name.trim();
  const brand = candidate.brand?.trim();
  if (!brand) return name;
  return name.toLowerCase().startsWith(brand.toLowerCase()) ? name : `${brand} ${name}`;
}

export function buildMatchPrompt(entries: LineCandidates[]): string {
  const payload = entries.map((entry, index) => ({
    line: index,
    text: describeLine(entry.line),
    candidates: entry.candidates.slice(0, MAX_CANDIDATES).map((candidate, position) => ({
      index: position,
      name: displayName(candidate),
    })),
  }));

  return [
    'You match a German supermarket shopping list to catalogue products.',
    'For every list line pick the candidate that IS the product the shopper means.',
    'Prefer the plain, ordinary product over a speciality variant unless the line says otherwise.',
    'Use null when none of the candidates is that product, or when the line is not a product.',
    'Never invent a product. Use only the candidate indices listed for that line, and only the line numbers given.',
    `Lines and candidates:\n${JSON.stringify(payload)}`,
    'Return JSON only: {"picks":[{"line":number,"index":number|null,"why":"<max 12 words>"}]}',
  ].join('\n');
}

/** Validate the answer: a pick survives only if it points into that line's own list. */
export function readPicks(raw: unknown, entries: LineCandidates[]): Array<number | null> {
  const picks = (raw as { picks?: unknown } | null)?.picks;
  const result: Array<number | null> = entries.map(() => null);
  if (!Array.isArray(picks)) return result;

  for (const pick of picks) {
    if (!pick || typeof pick !== 'object') continue;
    const { line, index } = pick as { line?: unknown; index?: unknown };
    if (!Number.isInteger(line) || (line as number) < 0 || (line as number) >= entries.length) continue;

    // The list we sent for that line is the only menu it may order from: a line given
    // no candidates accepts nothing, and the slice cap is what the prompt showed.
    const limit = Math.min(entries[line as number].candidates.length, MAX_CANDIDATES);
    const valid = Number.isInteger(index) && (index as number) >= 0 && (index as number) < limit;
    // A later invalid answer — including an explicit `null` — does not erase a pick.
    if (valid) result[line as number] = index as number;
  }
  return result;
}

/** One batched call for the whole list; throws when opencode cannot answer. */
export async function chooseWithModel(
  entries: LineCandidates[],
  options: ChooseOptions = {}
): Promise<Array<number | null>> {
  if (entries.every((entry) => entry.candidates.length === 0)) return entries.map(() => null);
  const raw = await runPrompt(buildMatchPrompt(entries), options);
  return readPicks(raw, entries);
}
