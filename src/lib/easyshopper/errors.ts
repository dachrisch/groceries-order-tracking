/**
 * The store account is missing.
 *
 * Creating the EDEKA device account is an external side effect: the store app
 * registers a real user. It must happen only when the shopper explicitly asks
 * for it, never because they pressed "+" on a product or opened a list, so every
 * caller that needs the account has to handle this instead of signing up.
 */
export class EdekaNotConnectedError extends Error {
  readonly code = 'edeka-not-connected';

  constructor(message = 'Connect EDEKA in Settings first') {
    super(message);
    this.name = 'EdekaNotConnectedError';
  }
}

export function isEdekaNotConnected(error: unknown): error is EdekaNotConnectedError {
  return error instanceof EdekaNotConnectedError;
}
