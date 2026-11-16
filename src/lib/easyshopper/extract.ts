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
import { runPrompt, NOT_AN_ANSWER, type ModelRef, type PromptFile } from '../opencode-client';
import { parseListLine, type ListLine } from './match';

const MAX_LINES = 60;
const MAX_LINE_LENGTH = 80;
/** One ceiling for any quantity, from either path: a misread number must not become an amount. */
const MAX_TEXT_QUANTITY = 99;
/** What the shopper sees when no model could read the photo; the job stores exactly
 * this string, so the two modules must share one constant rather than two literals. */
export const NO_READABLE_LIST = 'the photo contained no readable shopping list';

/**
 * Per attempt, not per call, and the chain is bounded on both sides: two free models,
 * then one curated paid model.
 *
 * A timeout is non-retryable in `runPrompt` (it moves straight to the next model), so a
 * chain where every model *hangs* costs (2 free × 45 s) + (1 paid × 45 s) = 135 s. That
 * fits inside the job's 160 s deadline (`extract-jobs.ts`) and the UI's 150 s poll
 * budget, so the shopper is never told "took too long" while a chain is still spending.
 * The three attempts per free model only apply to *fast* transport errors, so they add
 * seconds, not minutes.
 *
 * 45 s is measured, not guessed: the one reliable free vision model answered this
 * project's real test photo in 7-26 s, while the models that hang never answered at all
 * inside two minutes. A model that needs longer than this is not slow, it is broken.
 */
const VISION_TIMEOUT_MS = 45_000;
/**
 * The reservation: the free tier gets two models, the paid fallback exactly one. The
 * paid budget is separate from the free one, so two free failures still leave the
 * curated fallback reachable — that is the whole point of "free first, paid as the
 * fallback". Both together are the 135 s hang bound above.
 */
const VISION_FREE_MODELS = 2;
const VISION_PAID_MODELS = 1;

/**
 * The wording here is load-bearing; a real photo on a ruled "Notizen" pad taught us why.
 *
 * 1. Items were ticked off with a pen stroke through them. The old prompt said "ignore
 *    crossed-out words", so a compliant model answered `{"lines":[]}` and the shopper was
 *    told their list was unreadable. A strike is a tick on a shopping list, never a
 *    deletion — the textarea is editable, so an unwanted line is one keystroke, while a
 *    dropped line sends them shopping without it.
 * 2. The JSON example used to spell out "Milch 1,5"/"Brot". One paid model answered the
 *    fixture photo by echoing that example instead of reading the image, which made a
 *    model look verified when it was not. Placeholders cannot be mistaken for an answer.
 */
const PROMPT = [
  'The attached photo shows a handwritten shopping list for a German supermarket.',
  'Transcribe every item as the shopper meant it. Keep product words, brand names and',
  'sizes exactly as written ("1,5", "500g", "1 l"). A leading quantity like "2x" or "3 ×"',
  'belongs to the quantity field.',
  'The pad is ruled, and items may have a pen stroke through them: that is a tick, not a',
  'deletion. Transcribe struck-through items too; the shopper removes what they no longer',
  'need. Ignore only non-items: checkboxes, dates, page numbers, a printed heading such as',
  '"NOTIZEN", and decorative borders.',
  'Keep each line short: what to buy and its size, without the packaging description.',
  'Never invent an item that is not in the photo.',
  'Return JSON only, using this shape (do not copy the placeholders):',
  '{"lines":[{"text":"<item>","quantity":<number>}]}',
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
 * Returns '' when there is no boundary to cut at — see the caller.
 */
function clampLine(text: string): string {
  if (text.length <= MAX_LINE_LENGTH) return text;
  const cut = text.slice(0, MAX_LINE_LENGTH);
  const boundary = cut.lastIndexOf(' ');
  // 80+ characters without a single space is a blob, not a product: an empty result
  // makes the caller drop it, rather than keeping eighty characters of noise.
  return boundary > 0 ? cut.slice(0, boundary).trim() : '';
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
              // A control byte or a zero-width joiner from JSON or a model's transcription
              // must not hide in a line or glue words together; emoji are left alone.
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

    // Some models leave the "2x" in the text and still answer quantity 1, others move
    // the number into the field and strip it from the text; taking the larger of the two
    // covers both. A zero, a negative or a non-integer means "quantity not stated", never
    // "drop the item": an extra line shows up in the editable textarea and is one
    // keystroke to delete, while a line dropped here is invisible and costs the shopper a
    // trip to the shop.
    // One ceiling for both paths: a quantity the shopper wrote is theirs up to the sanity
    // ceiling. A field value that cannot be a real count (0, negative, fractional, > 99)
    // falls back to the text quantity, while a text value over 99 is clamped to 99.
    const field = value?.quantity;
    const stated =
      Number.isInteger(field) && (field as number) >= 1 && (field as number) <= MAX_TEXT_QUANTITY
        ? (field as number)
        : 1;
    const quantity = Math.min(MAX_TEXT_QUANTITY, Math.max(parsed.quantity, stated));

    lines.push({ text: parsed.text, quantity });
    // Cap after the filters, so sixty junk entries cannot crowd out real lines.
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

/**
 * Read a shopping list off a photo. Throws when opencode or a vision model is missing,
 * and with `NO_READABLE_LIST` when no model could read one.
 */
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
  let raw: unknown;
  try {
    raw = await runPrompt(PROMPT, {
      files: [file],
      require: 'image',
      // Free vision models first, then — and only after they failed — the paid fallback.
      allowPaid: true,
      timeoutMs: VISION_TIMEOUT_MS,
      maxModels: VISION_FREE_MODELS,
      maxPaid: VISION_PAID_MODELS,
      // A model that never received the image still answers happily, with no lines;
      // that is not an answer, so the next model in the chain gets it.
      accept: (reply) => normalizeExtractedLines(reply).length > 0,
      onModelUsed: (model) => {
        answered = model;
      },
    });
  } catch (error) {
    // The client's "not an answer" is internal wording, and it is the likeliest failure
    // for an unreadable photo. The caller shows this message to the shopper.
    if (error instanceof Error && error.message === NOT_AN_ANSWER) {
      // Keeps a blurry photo and "every provider silently dropped the image"
      // distinguishable in the logs. Nothing sensitive in the line.
      console.warn('[easyshopper] no vision model could read the photo (replies rejected as non-answers)');
      throw new Error(NO_READABLE_LIST);
    }
    throw error;
  }

  const lines = normalizeExtractedLines(raw);
  if (lines.length === 0) {
    // Defensive: `accept` already refuses such a reply, so this only catches a client
    // that returns one anyway.
    throw new Error(NO_READABLE_LIST);
  }
  return {
    lines,
    model: answered ? `${answered.providerID}:${answered.id}` : undefined,
    paid: answered?.paid === true,
  };
}
