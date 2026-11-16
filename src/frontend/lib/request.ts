/**
 * A browser fetch with a deadline.
 *
 * Every page used to await `fetch` with no timeout, so a request that never
 * answered left a spinner on screen and nothing to press. Fifteen seconds is
 * longer than the slowest real read (the weekly model over a year of orders)
 * and short enough that "Try again" is still a useful offer.
 *
 * It calls the global `fetch` on purpose: `patchFetch` in `lib/api.ts` wraps it
 * with the CSRF token, and capturing a reference at module load would step
 * around that wrapper.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Did this failure come from the deadline rather than from the network? */
export function isTimeout(failure: unknown): boolean {
  return failure instanceof DOMException && failure.name === 'AbortError';
}

/** The one line a page shows when a read failed; the action is always "try again". */
export function loadFailureCopy(failure: unknown): string {
  return isTimeout(failure)
    ? 'The server did not answer in time. Nothing was changed.'
    : 'Could not reach the server. Nothing was changed.';
}
