/**
 * Photo of a handwritten shopping list -> list lines, read by opencode.
 *
 * This is the one deliberate exception to "opencode gets text only": a photo of
 * handwriting cannot be text. The image is downscaled in the browser already, is
 * never stored, and never logged; the model must answer with JSON list lines and
 * nothing else. Free vision models are tried first; the curated paid tier is only a
 * fallback (`allowPaid`), so a normal read costs nothing. Product selection happens
 * later, against candidates this backend fetched (see `choose.ts`).
 */
import { runPrompt, type ModelRef, type PromptFile } from '../opencode-client';
import { parseListLine, type ListLine } from './match';

/** Vision calls are slower than a text classification; retries must still fit. */
const VISION_TIMEOUT_MS = 180_000;
const MAX_LINES = 60;
const MAX_LINE_LENGTH = 80;
const MAX_QUANTITY = 20;

const PROMPT = [
  'The attached photo shows a handwritten shopping list for a German supermarket.',
  'Transcribe every item as the shopper meant it. Keep product words, brand names and',
  'sizes exactly as written ("1,5", "500g", "1 l"). A leading quantity like "2x" or "3 ×"',
  'belongs to the quantity field. Ignore checkboxes, dates, page numbers, crossed-out words',
  'and anything that is not a list item. Never invent an item that is not in the photo.',
  'Return JSON only: {"lines":[{"text":"Milch 1,5","quantity":2},{"text":"Brot","quantity":1}]}',
  'quantity is an integer 1-20 and defaults to 1.',
].join(' ');

export interface ExtractedList {
  lines: ListLine[];
  /** `provider:id` of the model that answered, e.g. a paid fallback. */
  model?: string;
}

/** Keep the model's answer to actual list lines; everything else is dropped. */
export function normalizeExtractedLines(raw: unknown): ListLine[] {
  const entries = (raw as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(entries)) return [];

  const lines: ListLine[] = [];
  for (const entry of entries.slice(0, MAX_LINES)) {
    const value = (typeof entry === 'string' ? { text: entry } : entry) as Record<string, unknown> | null;
    const text = typeof value?.text === 'string' ? value.text.replace(/\s+/g, ' ').trim() : '';
    if (text.length < 2 || text.length > MAX_LINE_LENGTH) continue;
    if (!/[A-Za-zÄÖÜäöüß]/.test(text)) continue;

    // A stated zero is the model saying "crossed out, not wanted"; resurrecting it
    // as quantity 1 would put a struck-through item back on the list.
    const quantity = value?.quantity;
    if (quantity === 0) continue;

    const parsed = parseListLine(text);
    if (!parsed) continue;

    // Some models leave the "2x" in the text and still answer quantity 1; taking the
    // larger of the two keeps the quantity in both directions.
    const stated =
      Number.isInteger(quantity) && (quantity as number) >= 1 && (quantity as number) <= MAX_QUANTITY
        ? (quantity as number)
        : 1;

    lines.push({ text: parsed.text, quantity: Math.max(parsed.quantity, stated) });
  }
  return lines;
}

/** Read a shopping list off a photo. Throws when opencode or a vision model is missing. */
export async function extractListLines(imageBase64: string): Promise<ExtractedList> {
  const uri = imageBase64.startsWith('data:')
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;
  const file: PromptFile = {
    uri,
    name: 'shopping-list.jpg',
    description: 'photo of a handwritten shopping list',
    source: { type: 'inline' },
  };

  let answered: ModelRef | undefined;
  const raw = await runPrompt(PROMPT, {
    files: [file],
    require: 'image',
    // Free vision models first; the paid tier only answers when they all failed.
    allowPaid: true,
    timeoutMs: VISION_TIMEOUT_MS,
    onModelUsed: (model) => {
      answered = model;
    },
  });

  const lines = normalizeExtractedLines(raw);
  if (lines.length === 0) {
    throw new Error('the photo contained no readable shopping list');
  }
  return { lines, model: answered ? `${answered.providerID}:${answered.id}` : undefined };
}
