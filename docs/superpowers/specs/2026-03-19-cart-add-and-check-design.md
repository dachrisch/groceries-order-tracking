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

## Backend — `cart.controller.ts`

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

`productId` must be sent as a **number** (not string). `actionId` is null for reorders. `source` is the literal string `"reorder"`.

### Cart check

After a successful add (2xx response), call:

```
GET https://www.knuspr.de/services/frontend-service/v2/cart-review/check-cart
```

Same session cookie. Parse the response and return a normalized payload:

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
        "imgPath": "/images/grocery/products/126168/...",
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

`items` is derived from `data.items` (a map); flatten to an array. Include `multipack` only when present. `totalSavings` is included only when > 0.

### Error handling

- If the add call fails: return the Knuspr status code + error message, do not call check-cart.
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
  imgPath: string;
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

### Reorder button state

After a successful add, the product ID is added to `addedItems`. The Reorder button for that item:
- Changes icon from `ShoppingCart` to `Check`
- Turns green (`btn-success`)
- Is disabled (not re-orderable in the same session)
- No longer shows a spinner

### Cart summary section

Rendered below the inventory grid when `cart()` is non-null.

Contents:
- **Header:** "Your Knuspr Cart" with cart item count
- **Item list:** for each cart item — product name, textual amount, quantity × price, multipack badge if `multipack` present (shows `3 for €X.XX` and `−Y%`)
- **Footer:** total price (bold), total savings line if `totalSavings > 0`, "Open Cart on Knuspr" button linking to `https://www.knuspr.de/bestellung/mein-warenkorb` (opens in new tab)

The cart signal is replaced (not merged) on each reorder response — the full current cart is always reflected.

---

## Files Changed

| File | Change |
|------|--------|
| `src/api/controllers/cart.controller.ts` | Fix add endpoint URL + payload; add check-cart call; normalize and return cart |
| `src/frontend/pages/Inventory.tsx` | Add `addedItems` + `cart` signals; update button UI; add cart summary section |

## Out of Scope

- Removing items from the cart
- Changing quantities after adding
- Persisting cart state across page reloads
- Handling the `actionId` from order history (future enhancement)
