/**
 * The list textarea's contract with the backend, as pure functions.
 *
 * The plan/create schemas accept at most 60 lines of 200 characters each. A photo may
 * already answer 60 lines, `appendLines` merges them with what the shopper typed, and a
 * body over the cap is a `400` whose text is raw zod detail. These helpers keep the
 * body valid and give the UI sentences to show instead.
 */

/** Mirrors `planSchema.lines` in `easyshopper.controller.ts`. */
export const MAX_LIST_LINES = 60;
export const MAX_LIST_LINE_LENGTH = 200;

/** Shown when appending the photo's lines would push the list past its cap. */
export const FULL_LIST_MESSAGE = 'the list is full — 60 lines is the maximum';

/** A `400` from the plan routes is schema detail for the logs, not for the shopper. */
const REFUSED_LIST_MESSAGE = `that list was refused — keep to ${MAX_LIST_LINES} lines of ${MAX_LIST_LINE_LENGTH} characters and try again`;

/** Non-blank textarea lines, trimmed, in the order the shopper wrote them. */
function usableLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The body's `lines`: one entry per non-blank line, each clamped to the schema's
 * length and the whole list to its cap. Clamping rather than rejecting keeps a very
 * long line as a matchable prefix instead of failing the request.
 */
export function listLinesFromText(text: string): string[] {
  return usableLines(text)
    .map((line) => line.slice(0, MAX_LIST_LINE_LENGTH))
    .slice(0, MAX_LIST_LINES);
}

/** Whether the textarea holds more lines than the schema will take. */
export function listOverflows(text: string): boolean {
  return usableLines(text).length > MAX_LIST_LINES;
}

export interface ExtractedLine {
  text: string;
  quantity: number;
}

/**
 * Add the lines a photo yielded to what the shopper already typed, without duplicating
 * a line from either side. The cap is applied after the merge — first the typed lines,
 * then as many new ones as fit — so a photo cannot silently push the list past the
 * schema and turn the next click into a `400`. `truncated` says a line was dropped, so
 * the caller can tell the shopper why the list stops short.
 */
export function mergeExtractedLines(
  current: string,
  extracted: ExtractedLine[]
): { text: string; truncated: boolean } {
  const merged = usableLines(current);
  const formatted = extracted.map((line) => (line.quantity > 1 ? `${line.quantity}x ${line.text}` : line.text));
  for (const line of formatted) {
    if (!merged.includes(line)) merged.push(line);
  }
  const kept = merged.slice(0, MAX_LIST_LINES);
  return { text: kept.join('\n'), truncated: merged.length > kept.length };
}

/**
 * Shopper-facing text for a refused plan/create call. `replyMessage` already handles
 * the conversational statuses; a `400` only ever means the body did not match the
 * schema, and zod's wording ("Too big: expected array to have <=60 items") is not a
 * sentence a shopper should read.
 */
export function listRefusalMessage(status: number, backendError: string | undefined, fallback: string): string {
  if (status === 400) return REFUSED_LIST_MESSAGE;
  return backendError ?? fallback;
}
