# Cart Check & Restock Quantity Design

**Date:** 2026-03-19
**Status:** Approved

## Summary

Extend the Inventory page so that:
1. The current Knuspr cart is fetched on page load and reflected in the UI (items already in cart show as "Added", cart summary is visible immediately).
2. Inventory items include a typical restock quantity derived from order history.
3. The "Reorder" button expands inline into a quantity stepper before adding to cart.

---

## Backend

### New endpoint: `GET /api/cart`

- **Handler:** `handleGetCart` added to `src/api/controllers/cart.controller.ts`
- **Auth:** requires JWT (same `auth` middleware as other protected routes)
- **Logic:**
  1. If `req.derivedKey` is absent, return `{ cart: null }` (treat as non-fatal, same as missing integration — do not 401, since this endpoint is used for a best-effort load).
  2. Look up the user's `knuspr` Integration. If missing, return `{ cart: null }`.
  3. Decrypt credentials with `req.derivedKey`. If decryption fails, return `{ cart: null }`.
  4. Call `loginToKnuspr`, obtain session cookie.
  5. Call `GET https://www.knuspr.de/services/frontend-service/v2/cart-review/check-cart`.
  6. Normalize response with the existing `normalizeCart()` helper.
  7. Return `{ cart: NormalizedCart }` or `{ cart: null }` on any Knuspr-side failure (non-fatal).
- **Route:** `GET /api/cart` registered in `src/api/app.ts`

### Inventory aggregation: add `avgQuantity`

- **File:** `src/api/controllers/inventory.controller.ts`
- In the `$group` stage, push `{ date: '$orderTimeDate', amount: '$items.amount' }` tuples into a `purchases` array (replacing the current bare date push). This keeps date and amount aligned in a single sortable array.
- In the `$project` stage, sort the `purchases` array by `date` descending, slice to 5 elements (same logic as before for dates).
- Extract `purchaseDates` via `$map` from the sorted/sliced array (for `avgInterval` calculation, unchanged).
- Extract `amounts` via `$map` from the same sorted/sliced array.
- Add `avgQuantity`: average of the extracted `amounts`, rounded to nearest integer, minimum 1.
- The `InventoryItem` response shape gains `avgQuantity: number`.

---

## Frontend

### `src/frontend/pages/Inventory.tsx`

**Interface update:**

The `InventoryItem` TypeScript interface in `Inventory.tsx` must add `avgQuantity: number`.

**Signals added / changed:**
- `cartLoading: boolean` — true only while the initial cart fetch is in flight (independent of the main `loading` signal; they run in parallel via `Promise.all`)
- `reorderingItem: string | null` — ID of the item whose stepper is open (replaces `reordering`)
- `addingToCart: boolean` — true while a `/api/cart/add` request is in flight (replaces the global guard role of the old `reordering` signal); prevents concurrent adds
- `pendingQtys: Map<string, number>` — chosen qty per item while the stepper is open. **Must be updated immutably:** `setPendingQtys(prev => new Map(prev).set(id, qty))` — consistent with the `addedItems` `Set` pattern already in use

**On mount — parallel fetches:**
```
Promise.all([fetchInventory(), fetchCart()])
```
`fetchCart()` calls `GET /api/cart`. On success, sets `cart()` and seeds `addedItems` from `cart.items[].productId` cast to string (`String(productId)`). Fails silently — no error banner.

**Refresh button:** re-fetches both inventory and cart (`fetchInventory` + `fetchCart`), same as mount.

**Inline qty stepper:**

When `reorderingItem() === item._id`, the card's action area shows:
```
[−]  [qty]  [+]  [Add to Cart]
```
- Default qty is `item.avgQuantity`. On first open, `pendingQtys` is seeded for that item if not already set.
- Only one item stepper is open at a time — opening a new item's stepper closes the previous one (set `reorderingItem` to the new ID).
- `−` clamps at 1.
- `+` has no upper bound enforced client-side.
- "Add to Cart" is disabled while `addingToCart` is true.
- Clicking "Add to Cart" sets `addingToCart = true`, calls `/api/cart/add` with the chosen qty, then sets `addingToCart = false` and collapses the stepper (sets `reorderingItem = null`).
- The old "Reorder" button click now opens the stepper instead of immediately adding.

**Cart summary area:**

- While `cartLoading()` is true, show a DaisyUI skeleton placeholder at the bottom of the page (same position as the cart summary card).
- Once loaded, the existing cart summary JSX renders normally.
- If cart is null (empty or failed), nothing renders (existing `<Show when={cart()}>` handles this).

---

## Error handling

| Scenario | Behaviour |
|---|---|
| No Knuspr integration | `GET /api/cart` returns `{ cart: null }`, frontend shows nothing |
| Missing derived key on cart load | `GET /api/cart` returns `{ cart: null }`, frontend shows nothing |
| Knuspr login fails on cart load | `{ cart: null }`, silent |
| Knuspr login fails on add-to-cart | Existing error toast (unchanged) |
| Cart fetch network error | Caught, `cart` stays null, no banner |

---

## Files changed

| File | Change |
|---|---|
| `src/api/controllers/cart.controller.ts` | Add `handleGetCart` |
| `src/api/app.ts` | Register `GET /api/cart` |
| `src/api/controllers/inventory.controller.ts` | Push tuples, add `avgQuantity` to aggregation |
| `src/frontend/pages/Inventory.tsx` | Cart load on mount, stepper UX, new signals, cart skeleton, refresh re-fetches cart |

---

## Out of scope

- Quantity adjustment for items already in cart (would require a PATCH endpoint)
- Removing items from cart
- Caching cart state between page visits
