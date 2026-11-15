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

const MAX_LINES = 60;
const MAX_LINE_LENGTH = 80;
/** The model's own quantity field is 1..20; a quantity the shopper wrote can be larger. */
const MAX_QUANTITY = 20;
/** Hard ceiling for any quantity, from either path: a misread number must not become an amount. */
const MAX_TEXT_QUANTITY = 99;

/**
 * Per attempt, not per call: `runPrompt` gives each free model three attempts and each
 * paid model one, so the whole chain costs models × attempts × this. A timeout fails
 * over to the next model instead of being retried, because a vision call that hung on
 * one image rarely answers on a second try. Keep the total well under the UI's patience.
 */
const VISION_TIMEOUT_MS = 90_000;

const PROMPT = [
  'The attached photo shows a handwritten shopping list for a German supermarket.',
  'Transcribe every item as the shopper meant it. Keep product words, brand names and',
  'sizes exactly as written ("1,5", "500g", "1 l"). A leading quantity like "2x" or "3 ×"',
  'belongs to the quantity field. Keep each line short: what to buy and its size, without',
  'the packaging description. Ignore checkboxes, dates, page numbers, crossed-out words',
  'and anything that is not a list item. Never invent an item that is not in the photo.',
  'Return JSON only: {"lines":[{"text":"Milch 1,5","quantity":2},{"text":"Brot","quantity":1}]}',
  'quantity is the number written before the item, or 1 when there is none.',
].join(' ');

export interface ExtractedList {
  lines: ListLine[];
  /** `provider:id` of the model that answered, e.g. a paid fallback. */
  model?: string;
  /** True when the answer came from the paid fallback tier. */
  paid?: boolean;
}

/**
 * Cut an over-long line at a word boundary instead of dropping it: a long
 * "Waschmittel … 100WL 4,5kg" is a real item, and matching works on a prefix.
 */
function clampLine(text: string): string {
  if (text.length <= MAX_LINE_LENGTH) return text;
  const cut = text.slice(0, MAX_LINE_LENGTH);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > 0 ? cut.slice(0, boundary) : cut).trim();
}

/**
 * Keep the model's answer to actual list lines; everything else is dropped.
 * A legible line is never dropped; only its quantity falls back to 1.
 */
export function normalizeExtractedLines(raw: unknown): ListLine[] {
  const entries = (raw as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(entries)) return [];

  const lines: ListLine[] = [];
  for (const entry of entries) {
    const value = (typeof entry === 'string' ? { text: entry } : entry) as Record<string, unknown> | null;
    const text =
      typeof value?.text === 'string'
        ? clampLine(
            value.text
              .replace(/\s+/g, ' ')
              // A control byte or a zero-width joiner from JSON/OCR must not hide in a
              // line or glue words together; emoji are left alone.
              // oxlint-disable-next-line no-control-regex -- stripping control bytes is the point
              .replace(/[\u0000-\u001f\u200b-\u200f]/g, '')
              .trim()
          )
        : '';
    if (text.length < 2) continue;
    // Two letters, so a bare "2x" is not turned into a product.
    if (!/[A-Za-zÄÖÜäöüß]{2,}/.test(text)) continue;

    const parsed = parseListLine(text);
    if (!parsed) continue;

    // Some models leave the "2x" in the text and still answer quantity 1; taking the
    // larger of the two keeps the quantity in both directions. A zero, a negative or a
    // non-integer means "quantity not stated", never "drop the item": an extra line
    // shows up in the editable textarea and is one keystroke to delete, while a line
    // dropped here is invisible and costs the shopper a trip to the shop.
    const quantity = value?.quantity;
    const stated =
      Number.isInteger(quantity) && (quantity as number) >= 1 && (quantity as number) <= MAX_QUANTITY
        ? (quantity as number)
        : 1;

    // The model's own quantity is 1..20; a quantity the shopper wrote in the text is
    // theirs to make larger (a crate of 24 is real), but MAX_TEXT_QUANTITY is the sanity
    // ceiling so a misread number can never reach the cart as an absurd amount.
    lines.push({ text: parsed.text, quantity: Math.min(MAX_TEXT_QUANTITY, Math.max(parsed.quantity, stated)) });
    // Cap after the filters, so sixty junk entries cannot crowd out real lines.
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

/** Read a shopping list off a photo. Throws when opencode or a vision model is missing. */
export async function extractListLines(imageBase64: string): Promise<ExtractedList> {
  const mime = /^data:([^;,]+)/i.exec(imageBase64)?.[1].toLowerCase() ?? 'image/jpeg';
  // A bare payload carries no type; the browser always sends a data URI, so that is the
  // documented assumption here.
  const uri = imageBase64.startsWith('data:')
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;
  const file: PromptFile = {
    uri,
    name: `shopping-list.${mime.split('+')[0].split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'jpg'}`,
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
    // A model that never received the image still answers happily, with no lines;
    // that is not an answer, so the next model (and eventually the paid tier) gets it.
    accept: (reply) => normalizeExtractedLines(reply).length > 0,
    onModelUsed: (model) => {
      answered = model;
    },
  });

  const lines = normalizeExtractedLines(raw);
  if (lines.length === 0) {
    throw new Error('the photo contained no readable shopping list');
  }
  return {
    lines,
    model: answered ? `${answered.providerID}:${answered.id}` : undefined,
    paid: answered?.paid === true,
  };
}
