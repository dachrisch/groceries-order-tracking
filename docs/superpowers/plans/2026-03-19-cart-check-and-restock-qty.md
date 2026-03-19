# Cart Check & Restock Quantity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch the live Knuspr cart on Inventory page load, pre-mark items already in cart as "Added", show a cart summary immediately, and replace the one-click "Reorder" button with an inline quantity stepper defaulting to each item's typical purchase amount.

**Architecture:** Add `GET /api/cart` backend endpoint reusing existing `normalizeCart()` and `loginToKnuspr` helpers; extend the inventory aggregation to track purchase amounts alongside dates (tuple approach) to compute `avgQuantity`; update `Inventory.tsx` to parallel-fetch cart+inventory on mount, manage stepper state with new signals, and show a skeleton while cart loads.

**Tech Stack:** Express + Mongoose + Vitest (backend), SolidJS + Tailwind + DaisyUI (frontend)

**Spec:** `docs/superpowers/specs/2026-03-19-cart-check-and-restock-qty-design.md`

---

## File Map

| File | Change |
|---|---|
| `src/api/controllers/cart.controller.ts` | Add `handleGetCart` (export alongside existing `handleAddToCart`) |
| `src/api/app.ts` | Add import for `handleGetCart`, register `GET /api/cart` route |
| `src/api/controllers/inventory.controller.ts` | Refactor aggregation to push `{date, amount}` tuples; add `avgQuantity` field |
| `src/api/__tests__/cart.test.ts` | Add `GET /api/cart` test suite |
| `src/frontend/pages/Inventory.tsx` | New signals, parallel fetch on mount, stepper UX, cart skeleton |

---

## Task 1: Add `handleGetCart` to cart controller

**Files:**
- Modify: `src/api/controllers/cart.controller.ts`

- [ ] **Step 1: Write failing test for `GET /api/cart` — no integration returns `{ cart: null }`**

Add a new `describe('GET /api/cart', ...)` block to `src/api/__tests__/cart.test.ts`:

```typescript
describe('GET /api/cart', () => {
  let cookies: string;
  let userId: string;

  beforeEach(async () => {
    await clearDB();
    vi.unstubAllGlobals();
    await registerUser();
    cookies = await loginUser();
    userId = await getSessionUserId(cookies);
  });

  it('returns { cart: null } when Knuspr is not connected', async () => {
    const res = await request(app)
      .get('/api/cart')
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.cart).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — confirm it fails with 404 (route not found yet)**

```bash
npm test -- --reporter=verbose src/api/__tests__/cart.test.ts
```

Expected: FAIL — `expected 404 to equal 200` (route doesn't exist yet)

- [ ] **Step 3: Implement `handleGetCart` in `cart.controller.ts`**

Add after the existing `handleAddToCart` function (and add `handleGetCart` to the exports):

```typescript
export async function handleGetCart(req: Request, res: Response) {
  if (!req.derivedKey) {
    return res.json({ cart: null });
  }

  const integration = await Integration.findOne({ userId: req.userId, provider: 'knuspr' });
  if (!integration?.encryptedCredentials) {
    return res.json({ cart: null });
  }

  let knusprEmail: string;
  let knusprPassword: string;
  try {
    const creds = JSON.parse(decrypt(integration.encryptedCredentials, req.derivedKey));
    knusprEmail = creds.email;
    knusprPassword = creds.password;
  } catch {
    return res.json({ cart: null });
  }

  try {
    const { session } = await loginToKnuspr(knusprEmail, knusprPassword);
    const sessionCookie = `PHPSESSION_de-production=${session}`;

    const cartResponse = await fetch(
      'https://www.knuspr.de/services/frontend-service/v2/cart-review/check-cart',
      { headers: { 'Cookie': sessionCookie, 'x-origin': 'WEB' } }
    );

    if (!cartResponse.ok) {
      return res.json({ cart: null });
    }

    const cartData = await cartResponse.json();
    return res.json({ cart: normalizeCart(cartData.data) });
  } catch {
    return res.json({ cart: null });
  }
}
```

- [ ] **Step 4: Register the route in `app.ts`**

In `src/api/app.ts`, update the cart controller import:

```typescript
import { handleAddToCart, handleGetCart } from './controllers/cart.controller';
```

Add the route after the existing cart route:

```typescript
app.get('/api/cart', auth, handleGetCart);
```

- [ ] **Step 5: Run test — confirm "no integration" case passes**

```bash
npm test -- --reporter=verbose src/api/__tests__/cart.test.ts
```

Expected: the new "no integration" test PASSES; all prior tests still PASS

---

## Task 2: Add remaining `GET /api/cart` tests

**Files:**
- Modify: `src/api/__tests__/cart.test.ts`

- [ ] **Step 1: Write failing tests for success and Knuspr-failure cases**

Add to the `describe('GET /api/cart', ...)` block:

```typescript
  it('returns normalized cart when Knuspr responds successfully', async () => {
    await Integration.create({
      userId,
      provider: 'knuspr',
      encryptedCredentials: 'encrypted',
      encryptedHeaders: null,
    });

    const mockCartResponse = {
      data: {
        cartId: 999,
        totalPrice: 5.59,
        totalSavings: 0,
        items: {
          '4864': {
            productId: 4864,
            productName: 'Kugler Obatzda',
            price: 5.59,
            quantity: 1,
            imgPath: '/images/grocery/products/4864/img.jpg',
            textualAmount: '270 g',
            multipack: null,
          },
        },
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockCartResponse,
    }));

    const res = await request(app)
      .get('/api/cart')
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.cart.cartId).toBe(999);
    expect(res.body.cart.totalPrice).toBe(5.59);
    expect(res.body.cart.items).toHaveLength(1);
    expect(res.body.cart.items[0].productId).toBe(4864);
    expect(res.body.cart.items[0].imgUrl).toBe(
      'https://www.knuspr.de/images/grocery/products/4864/img.jpg'
    );
    expect(res.body.cart.items[0].multipack).toBeUndefined();

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://www.knuspr.de/services/frontend-service/v2/cart-review/check-cart'
    );
  });

  it('returns { cart: null } when Knuspr check-cart fails', async () => {
    await Integration.create({
      userId,
      provider: 'knuspr',
      encryptedCredentials: 'encrypted',
      encryptedHeaders: null,
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network error')));

    const res = await request(app)
      .get('/api/cart')
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.cart).toBeNull();
  });

  it('returns { cart: null } when Knuspr returns non-ok status', async () => {
    await Integration.create({
      userId,
      provider: 'knuspr',
      encryptedCredentials: 'encrypted',
      encryptedHeaders: null,
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }));

    const res = await request(app)
      .get('/api/cart')
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.cart).toBeNull();
  });
```

- [ ] **Step 2: Run tests — confirm they pass**

```bash
npm test -- --reporter=verbose src/api/__tests__/cart.test.ts
```

Expected: all `GET /api/cart` tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/api/controllers/cart.controller.ts src/api/app.ts src/api/__tests__/cart.test.ts
git commit -m "feat(api): add GET /api/cart endpoint"
```

---

## Task 3: Add `avgQuantity` to inventory aggregation

**Files:**
- Modify: `src/api/controllers/inventory.controller.ts`

The current aggregation pushes bare `$orderTimeDate` dates into `purchases`. We need to push `{date, amount}` tuples so quantities stay aligned with their dates after sorting. The `avgInterval` logic is unchanged — it just reads from `purchaseDates` instead of `purchases` directly.

- [ ] **Step 1: Write failing test for `avgQuantity` in inventory response**

Add a new test to a new file `src/api/__tests__/inventory.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import {
  setupTestDB, clearDB, teardownTestDB,
  registerUser, loginUser, getSessionUserId,
  createOrder,
} from './helpers';

beforeAll(setupTestDB);
afterAll(teardownTestDB);

describe('GET /api/inventory', () => {
  let cookies: string;
  let userId: string;

  beforeEach(async () => {
    await clearDB();
    await registerUser();
    cookies = await loginUser();
    userId = await getSessionUserId(cookies);
  });

  // NOTE: createOrder spreads overrides — when overriding `items`, provide
  // the full item object (no partial merge with DEFAULT_ITEM).
  const makeItem = (id: number, name: string, amount: number, orderFieldId: number) => ({
    id, name, amount, orderFieldId,
    unit: 'l',
    textualAmount: '1 l',
    images: [],
    priceComposition: { total: { amount: 149, currency: 'EUR' }, unit: { amount: 149, currency: 'EUR' } },
    compensated: false,
  });

  it('returns avgQuantity based on typical order amounts', async () => {
    // Seed 3 orders for the same product with varying quantities
    await createOrder(userId, {
      orderTimeDate: new Date('2024-01-01'),
      items: [makeItem(42, 'Milk', 2, 1)],
    });
    await createOrder(userId, {
      orderTimeDate: new Date('2024-02-01'),
      items: [makeItem(42, 'Milk', 3, 2)],
    });
    await createOrder(userId, {
      orderTimeDate: new Date('2024-03-01'),
      items: [makeItem(42, 'Milk', 2, 3)],
    });

    const res = await request(app).get('/api/inventory').set('Cookie', cookies);

    expect(res.status).toBe(200);
    const item = res.body.find((i: any) => i._id === 42);
    expect(item).toBeDefined();
    expect(item.avgQuantity).toBeGreaterThanOrEqual(1);
    expect(typeof item.avgQuantity).toBe('number');
    // Average of [2, 3, 2] = 2.33 → rounds to 2
    expect(item.avgQuantity).toBe(2);
  });

  it('returns avgQuantity of at least 1 even for zero-amount items', async () => {
    await createOrder(userId, {
      orderTimeDate: new Date('2024-01-01'),
      items: [makeItem(55, 'Bread', 0, 10)],
    });
    await createOrder(userId, {
      orderTimeDate: new Date('2024-02-01'),
      items: [makeItem(55, 'Bread', 0, 11)],
    });

    const res = await request(app).get('/api/inventory').set('Cookie', cookies);

    expect(res.status).toBe(200);
    const item = res.body.find((i: any) => i._id === 55);
    expect(item.avgQuantity).toBe(1);
  });

  it('still returns correct avgInterval after refactor', async () => {
    // Verify the interval logic is intact after the tuple refactor
    await createOrder(userId, {
      orderTimeDate: new Date('2024-01-01'),
      items: [makeItem(77, 'Eggs', 1, 20)],
    });
    await createOrder(userId, {
      orderTimeDate: new Date('2024-02-01'),
      items: [makeItem(77, 'Eggs', 1, 21)],
    });

    const res = await request(app).get('/api/inventory').set('Cookie', cookies);

    const item = res.body.find((i: any) => i._id === 77);
    expect(item).toBeDefined();
    // ~31 days between Jan 1 and Feb 1
    expect(item.avgInterval).toBeCloseTo(31, 0);
    expect(item.daysSinceLast).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
npm test -- --reporter=verbose src/api/__tests__/inventory.test.ts
```

Expected: FAIL — `avgQuantity` is undefined

- [ ] **Step 3: Refactor inventory aggregation to use `{date, amount}` tuples**

Replace the `$group` through `$addFields` stages in `src/api/controllers/inventory.controller.ts`:

```typescript
// Stage 3: Group by item ID — push {date, amount} tuples to keep them aligned
{
  $group: {
    _id: '$items.id',
    name: { $first: '$items.name' },
    image: { $first: { $arrayElemAt: ['$items.images', 0] } },
    purchases: { $push: { date: '$orderTimeDate', amount: '$items.amount' } }
  }
},

// Stage 4: Sort tuples by date desc, keep most recent 5
{
  $project: {
    _id: 1,
    name: 1,
    image: 1,
    purchases: {
      $slice: [
        { $sortArray: { input: '$purchases', sortBy: { date: -1 } } },
        5
      ]
    }
  }
},

// Stage 5: Filter items purchased at least twice
{ $match: { 'purchases.1': { $exists: true } } },

// Stage 6: Extract dates and amounts from sorted tuples; compute avgQuantity
{
  $addFields: {
    lastPurchase: { $arrayElemAt: ['$purchases.date', 0] },
    purchaseDates: '$purchases.date',
    amounts: '$purchases.amount',
    avgQuantity: {
      $max: [
        1,
        {
          $round: [
            { $avg: '$purchases.amount' },
            0
          ]
        }
      ]
    }
  }
},

// Stage 7: Calculate intervals from purchaseDates (same logic as before)
{
  $addFields: {
    intervals: {
      $map: {
        input: { $range: [0, { $subtract: [{ $size: '$purchaseDates' }, 1] }] },
        as: 'idx',
        in: {
          $divide: [
            {
              $subtract: [
                { $arrayElemAt: ['$purchaseDates', '$$idx'] },
                { $arrayElemAt: ['$purchaseDates', { $add: ['$$idx', 1] }] }
              ]
            },
            1000 * 60 * 60 * 24
          ]
        }
      }
    }
  }
},

// Stage 8: Weighted average interval and daysSinceLast (unchanged logic)
{
  $addFields: {
    avgInterval: {
      $let: {
        vars: {
          g1: { $arrayElemAt: ['$intervals', 0] },
          g2: { $arrayElemAt: ['$intervals', 1] },
          g3: { $arrayElemAt: ['$intervals', 2] }
        },
        in: {
          $add: [
            { $multiply: ['$$g1', 0.5] },
            { $cond: ['$$g2', { $multiply: ['$$g2', 0.3] }, { $multiply: ['$$g1', 0.3] }] },
            { $cond: ['$$g3', { $multiply: ['$$g3', 0.2] }, { $multiply: ['$$g1', 0.2] }] }
          ]
        }
      }
    },
    daysSinceLast: {
      $divide: [
        { $subtract: [now, '$lastPurchase'] },
        1000 * 60 * 60 * 24
      ]
    }
  }
}
```

- [ ] **Step 4: Run tests — confirm all inventory tests pass**

```bash
npm test -- --reporter=verbose src/api/__tests__/inventory.test.ts
```

Expected: all 3 inventory tests PASS

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
npm test
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/api/controllers/inventory.controller.ts src/api/__tests__/inventory.test.ts
git commit -m "feat(api): add avgQuantity to inventory aggregation"
```

---

## Task 4: Update Inventory frontend — signals, cart fetch, skeleton

**Files:**
- Modify: `src/frontend/pages/Inventory.tsx`

This task wires up the new signals and parallel fetch. No stepper UI yet — that comes in Task 5.

- [ ] **Step 1: Add `avgQuantity` to `InventoryItem` interface**

In `src/frontend/pages/Inventory.tsx`, update the `InventoryItem` interface:

```typescript
interface InventoryItem {
  _id: number;  // MongoDB aggregation returns numeric IDs — use String(_id) when keying addedItems/pendingQtys
  name: string;
  image?: string;
  avgInterval: number;
  daysSinceLast: number;
  avgQuantity: number;
}
```

- [ ] **Step 2: Add new signals and replace `reordering` with the three new signals**

Replace:
```typescript
const [reordering, setReordering] = createSignal<string | null>(null);
```

With:
```typescript
const [cartLoading, setCartLoading] = createSignal(false);
const [reorderingItem, setReorderingItem] = createSignal<string | null>(null);
const [addingToCart, setAddingToCart] = createSignal(false);
const [pendingQtys, setPendingQtys] = createSignal<Map<string, number>>(new Map());
```

- [ ] **Step 3: Add `fetchCart` function**

Add after the existing `fetchInventory` function:

```typescript
const fetchCart = async () => {
  setCartLoading(true);
  try {
    const res = await fetch('/api/cart');
    if (res.ok) {
      const data = await res.json();
      if (data.cart) {
        setCart(data.cart);
        setAddedItems(new Set(
          (data.cart as Cart).items.map((i: CartItem) => String(i.productId))
        ));
      }
    }
  } catch {
    // silent fail — cart is best-effort
  } finally {
    setCartLoading(false);
  }
};
```

- [ ] **Step 4: Update `onMount` to run fetches in parallel**

Replace:
```typescript
onMount(fetchInventory);
```

With:
```typescript
onMount(() => Promise.all([fetchInventory(), fetchCart()]));
```

- [ ] **Step 5: Update the Refresh button handler to also re-fetch cart**

Replace:
```typescript
onClick={fetchInventory}
```

With:
```typescript
onClick={() => Promise.all([fetchInventory(), fetchCart()])}
```

- [ ] **Step 6: Add cart skeleton below the items grid**

Add before the existing `{/* Cart Summary */}` block:

```tsx
{/* Cart Loading Skeleton */}
<Show when={cartLoading()}>
  <div class="card bg-base-100 border border-base-300 shadow-xl">
    <div class="card-body">
      <div class="skeleton h-6 w-40 mb-4" />
      <div class="space-y-3">
        <div class="flex items-center gap-3">
          <div class="skeleton w-10 h-10 rounded-lg shrink-0" />
          <div class="flex-1 space-y-2">
            <div class="skeleton h-4 w-full" />
            <div class="skeleton h-3 w-24" />
          </div>
          <div class="skeleton h-5 w-14" />
        </div>
        <div class="flex items-center gap-3">
          <div class="skeleton w-10 h-10 rounded-lg shrink-0" />
          <div class="flex-1 space-y-2">
            <div class="skeleton h-4 w-3/4" />
            <div class="skeleton h-3 w-20" />
          </div>
          <div class="skeleton h-5 w-14" />
        </div>
      </div>
    </div>
  </div>
</Show>
```

- [ ] **Step 7: Verify dev server renders without TS errors**

```bash
npm run dev:backend &
npm run dev:frontend
```

Open `http://localhost:5173` in browser, navigate to Inventory page. Expected: page loads, cart skeleton appears briefly, then either the cart summary appears or nothing (if no items in cart). No console errors.

Kill the dev servers after verifying.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/pages/Inventory.tsx
git commit -m "feat(frontend): parallel cart fetch on inventory mount with skeleton"
```

---

## Task 5: Inline quantity stepper on Reorder button

**Files:**
- Modify: `src/frontend/pages/Inventory.tsx`

The "Reorder" button currently calls `reorder(item._id)` directly. We replace this with a two-step flow: click opens the stepper, confirm adds to cart.

- [ ] **Step 1: Replace the `reorder` function with `openStepper` and `addToCart`**

Remove the existing `reorder` function entirely. Add two new functions:

```typescript
// All interactions with addedItems and pendingQtys use String(item._id) because
// those Sets/Maps are keyed by string, while InventoryItem._id is numeric from MongoDB.

const openStepper = (item: InventoryItem) => {
  const id = String(item._id);
  if (addedItems().has(id)) return; // already in cart
  setReorderingItem(id);
  // Seed default qty from avgQuantity if not already set
  if (!pendingQtys().has(id)) {
    setPendingQtys(prev => new Map(prev).set(id, item.avgQuantity));
  }
};

const adjustQty = (itemId: string, delta: number) => {
  const current = pendingQtys().get(itemId) ?? 1;
  const next = Math.max(1, current + delta);
  setPendingQtys(prev => new Map(prev).set(itemId, next));
};

const addToCart = async (productId: string) => {
  if (addingToCart()) return;
  const qty = pendingQtys().get(productId) ?? 1;

  setAddingToCart(true);
  try {
    const res = await fetch('/api/cart/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, count: qty })
    });

    if (res.ok) {
      const data = await res.json();
      setAddedItems(prev => new Set([...prev, productId]));
      if (data.cart) setCart(data.cart);
      showToast('Added to Knuspr cart!');
      setReorderingItem(null);  // collapse stepper only on success
    } else {
      showToast('Failed to add item to cart.', 'error');
      // stepper stays open so user can retry with same qty
    }
  } catch {
    showToast('Connection error. Could not add to cart.', 'error');
    // stepper stays open so user can retry
  } finally {
    setAddingToCart(false);
  }
};
```

- [ ] **Step 2: Replace the card action area JSX**

Find the `<div class="card-actions justify-end mt-4">` block and replace its contents:

```tsx
<div class="card-actions justify-end mt-4">
  <Show
    when={reorderingItem() === String(item._id)}
    fallback={
      <button
        class={`btn btn-sm gap-2 ${addedItems().has(String(item._id)) ? 'btn-success' : 'btn-primary'}`}
        onClick={() => openStepper(item)}
        disabled={addedItems().has(String(item._id))}
      >
        <Show when={addedItems().has(String(item._id))} fallback={<ShoppingCart size={16} />}>
          <Check size={16} />
        </Show>
        {addedItems().has(String(item._id)) ? 'Added' : 'Reorder'}
      </button>
    }
  >
    <div class="flex items-center gap-1">
      <button
        class="btn btn-sm btn-ghost btn-square"
        onClick={() => adjustQty(String(item._id), -1)}
        disabled={addingToCart()}
      >−</button>
      <span class="w-8 text-center font-mono text-sm">
        {pendingQtys().get(String(item._id)) ?? item.avgQuantity}
      </span>
      <button
        class="btn btn-sm btn-ghost btn-square"
        onClick={() => adjustQty(String(item._id), 1)}
        disabled={addingToCart()}
      >+</button>
      <button
        class="btn btn-sm btn-primary gap-1"
        onClick={() => addToCart(String(item._id))}
        disabled={addingToCart()}
      >
        <Show when={addingToCart()}>
          <span class="loading loading-spinner loading-xs" />
        </Show>
        Add
      </button>
    </div>
  </Show>
</div>
```

- [ ] **Step 3: Verify in dev browser**

```bash
npm run dev:backend &
npm run dev:frontend
```

Navigate to Inventory page. Expected:
- Items with products in cart already show "Added" (green, disabled)
- Clicking "Reorder" on an available item expands to `−  1  +  Add`
- Adjusting with `−`/`+` changes the count (clamps at 1)
- Clicking "Add" sends the request, collapses stepper, shows toast, button turns green "Added"
- Cart summary updates with new item

Kill dev servers.

- [ ] **Step 4: Run full test suite to confirm no regressions**

```bash
npm test
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/frontend/pages/Inventory.tsx
git commit -m "feat(frontend): inline qty stepper for inventory reorder"
```
