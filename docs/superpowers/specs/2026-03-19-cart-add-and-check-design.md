# Cart Add & Check Design

**Date:** 2026-03-19
**Status:** Approved

## Problem

The current `POST /api/cart/add` backend handler calls a Knuspr **metrics** endpoint (`/services/frontend-service/metric/add-to-cart`) which is a tracking event, not a real cart add. Items are not actually added to the Knuspr cart. The frontend also gives no feedback beyond a generic toast.

## Goal

1. Fix the add-to-cart backend to call the correct Knuspr API.
2. After adding, verify the cart state via the check-cart API and return it.
3. Display a persistent cart summary on the Inventory page with items marked as added.

## Approach

Option A: backend handles add + check-cart in a single request; frontend receives the full cart state in the response.

---

## Backend — `POST /api/cart/add` (`cart.controller.ts`)

### Session

Call `loginToKnuspr(email, password)` **once** at the start of the handler. The resulting `session` cookie is reused for both the add call and the check-cart call — no second login is needed. The `userId` returned by `loginToKnuspr` is not used in the new flow and should be omitted from the destructuring (or assigned to `_`) to avoid a TypeScript unused-variable error.

### Schema update

The existing `addToCartSchema` transforms `productId` to a `String`. The frontend sends `item._id` (a string representation of the Knuspr numeric product ID) as `productId`. The schema should accept a string or number and coerce to `Number` (e.g. `z.union([z.string(), z.number()]).transform(Number)`) so the Knuspr request body always receives a numeric `productId`. The frontend does not need to send a number explicitly.

### Real add call

Replace the existing metric endpoint with:

```
POST https://www.knuspr.de/api/v1/cart/item
```

Request body:
```json
{ "amount": 1, "productId": 71396, "actionId": null, "source": "reorder" }
```

Required headers:
- `Cookie: PHPSESSION_de-production=<session>`
- `Content-Type: application/json`
- `x-origin: WEB`
- `origin: https://www.knuspr.de`

`productId` must be a **number**. `actionId` is `null` for reorders. `source` is the literal string `"reorder"`.

### Cart check

After a successful add (2xx response), call:

```
GET https://www.knuspr.de/services/frontend-service/v2/cart-review/check-cart
```

Same `PHPSESSION_de-production` cookie from the single `loginToKnuspr` call above.

Normalize `data.items` (a map keyed by productId) into an array. Build and return:

```json
{
  "success": true,
  "cart": {
    "cartId": 32951137,
    "totalPrice": 0.49,
    "totalSavings": 0,
    "items": [
      {
        "productId": 126168,
        "productName": "Berliner Mehrfrucht",
        "price": 0.49,
        "quantity": 1,
        "imgUrl": "https://www.knuspr.de/images/grocery/products/126168/...",
        "textualAmount": "70 g",
        "multipack": {
          "price": 0.36,
          "savedPercents": 26.53,
          "needAmount": 3
        }
      }
    ]
  }
}
```

Notes:
- `imgUrl` is constructed by prepending `https://www.knuspr.de` to the `imgPath` field from the Knuspr response.
- `multipack` is included only when present in the Knuspr response item.
- `totalSavings` is always present in the response (default `0`).

### Error handling

- If the add call fails: return the Knuspr status code + error message; do not call check-cart.
- If check-cart fails: return `{ success: true, cart: null }` — the add succeeded even if we can't read the cart.

---

## Frontend — `Inventory.tsx`

### New signals

```ts
const [addedItems, setAddedItems] = createSignal<Set<string>>(new Set());
const [cart, setCart] = createSignal<Cart | null>(null);
```

Where `Cart` is:
```ts
interface CartItem {
  productId: number;
  productName: string;
  price: number;
  quantity: number;
  imgUrl: string;
  textualAmount: string;
  multipack?: { price: number; savedPercents: number; needAmount: number };
}
interface Cart {
  cartId: number;
  totalPrice: number;
  totalSavings: number;
  items: CartItem[];
}
```

### addedItems key

In the inventory aggregate, `item._id` is set to the Knuspr numeric product ID (from `$items.id`) and is serialised as a string in JSON. It doubles as the product ID — there is no separate `productId` field on `InventoryItem`. `addedItems` is keyed by `item._id`. After a successful add, `item._id` is added to the set.

The `reorder` function should guard at the top on both `reordering()` and `addedItems()`:
```ts
if (reordering() || addedItems().has(productId)) return;
```

The button disabled check is: `reordering() === item._id || addedItems().has(item._id)`.

### Reorder button state

The button shows three states based on priority:

| Condition | Icon | Style | Disabled |
|-----------|------|-------|----------|
| `reordering() === item._id` | spinner | `btn-primary` | yes |
| `addedItems().has(item._id)` | `Check` | `btn-success` | yes |
| default | `ShoppingCart` | `btn-primary` | no |

Once added, the button stays green and disabled for the remainder of the session (no re-ordering).

### Cart summary section

Rendered below the inventory grid when `cart()` is non-null.

Contents:
- **Header:** "Your Knuspr Cart" with cart item count
- **Item list:** for each cart item — product image (`imgUrl`), product name, textual amount, quantity × price, multipack badge if `multipack` present (shows e.g. `3 for €0.36` and `−27%`)
- **Footer:** total price (bold), total savings line if `totalSavings > 0`, "Open Cart on Knuspr" link button to `https://www.knuspr.de/bestellung/mein-warenkorb` (opens in new tab)

The cart signal is replaced (not merged) on each reorder response — the full current cart is always shown.

---

## Files Changed

| File | Change |
|------|--------|
| `src/api/controllers/cart.controller.ts` | Fix add endpoint URL + payload; coerce productId to number; share one login session for add + check-cart; normalize and return cart |
| `src/frontend/pages/Inventory.tsx` | Add `addedItems` + `cart` signals; tri-state button logic; cart summary section below grid |

## Out of Scope

- Removing items from the cart
- Changing quantities after adding
- Persisting cart state across page reloads
- Handling `actionId` from order history (future enhancement)
