import { AztecCodeWriter, BarcodeFormat } from '@zxing/library';

/**
 * The EASY Shopper app shares a shopping list by displaying an **Aztec** barcode whose
 * payload is the owner's `userGuid` (not a URL, not a link token). The follower scans
 * it from "Connect to Another Shopping List" and the app then calls
 * `POST /v4/shoppingList/follow {userGuid}`.
 *
 * Rendered as one SVG path so it can be scaled without an image request.
 */
export function aztecSvg(data: string): { path: string; size: number } {
  const matrix = new AztecCodeWriter().encode(data, BarcodeFormat.AZTEC, 0, 0);
  const size = matrix.getWidth();
  const parts: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (matrix.get(x, y)) parts.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return { path: parts.join(''), size };
}
