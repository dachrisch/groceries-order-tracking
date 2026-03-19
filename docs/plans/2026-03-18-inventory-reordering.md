# Inventory & Automated Reordering Implementation Plan

> **For Gemini:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Enhance the application with an Inventory view that predicts stock levels, identifies items needing reorder, and facilitates one-click reordering via Knuspr.

**Architecture:**
- **Backend:** MongoDB aggregation pipeline for dynamic inventory status calculation (`/api/inventory`). A proxy endpoint (`/api/cart/add`) will handle Knuspr cart interactions.
- **Frontend:** A new `Inventory.tsx` page with tabs for different stock statuses ("Running Out", "Needs Reorder", "In Shelf", "Stale Stock") and visual indicators for frequently bought items.

**Tech Stack:** Node.js/Express, Mongoose/MongoDB, SolidJS, Tailwind CSS, DaisyUI, Lucide-Solid.

---

### Task 1: Backend - Update Integration Model

**Files:**
- Modify: `src/models/Integration.ts`

**Step 1: Add encrypted headers and cookies to the schema**
Update `IntegrationSchema` to include `encryptedCredentials` with `headers` and `cookies` fields. Ensure these are stored as encrypted strings.

```typescript
// src/models/Integration.ts (conceptual snippet)
import { Schema, model, Document } from 'mongoose';
import { IntegrationProvider } from '../types/enums'; // Assuming this enum exists

// Interface for the Integration document
interface IIntegration extends Document {
  userId: Schema.Types.ObjectId;
  provider: IntegrationProvider; // Use enum
  encryptedCredentials: {
    headers: string; // Storing encrypted JSON string of headers
    cookies: string; // Storing encrypted JSON string of cookies
  };
  lastSyncAt?: Date; // Or use timestamps: true
}

const integrationSchema = new Schema<IIntegration>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  provider: { type: String, required: true, enum: IntegrationProvider, index: true },
  encryptedCredentials: {
    headers: { type: String, required: true },
    cookies: { type: String, required: true },
  },
  // lastSyncAt: { type: Date, default: Date.now } // If timestamps: true is used, this might be auto-managed
}, { timestamps: true }); // Using timestamps for auto-managed createdAt/updatedAt

// Ensure unique provider per user
integrationSchema.index({ userId: 1, provider: 1 }, { unique: true });

export default model<IIntegration>('Integration', integrationSchema);
```

**Step 2: Commit**

```bash
git add src/models/Integration.ts
git commit -m "feat: update Integration model to store encrypted headers and cookies"
```

---

### Task 2: Backend - Inventory Aggregation API

**Files:**
- Create: `src/api/controllers/inventory.controller.ts`
- Modify: `src/api/server.ts`

**Step 1: Implement `/api/inventory` controller**
Create the controller that performs the MongoDB aggregation to calculate `avgInterval`, `daysSinceLast`, `isFrequentlyBought`, and `status` (IN_SHELF, RUNNING_OUT, NEEDS_REORDER, STALE).

```typescript
// src/api/controllers/inventory.controller.ts (conceptual snippet)
import { Request, Response } from 'express';
import Order from '../../models/Order';
import mongoose from 'mongoose';
import { decrypt } from '../../lib/crypto'; // Assuming crypto utility is available

// Constants for status thresholds
const REORDER_THRESHOLD = 0.7; // For RUNNING_OUT
const NEEDS_REORDER_THRESHOLD = 1.0; // For NEEDS_REORDER
const STALE_THRESHOLD_DAYS = 90; // For STALE

export const handleGetInventory = async (req: Request, res: Response) => {
  const userId = (req as any).userId; // Assuming userId is available from auth middleware
  const now = new Date();

  try {
    const inventory = await Order.aggregate([
      // Stage 1: Match user's orders
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      // Stage 2: Unwind order items to process each item purchase
      { $unwind: '$items' },
      // Stage 3: Group by item ID to get all purchase dates
      { $group: {
          _id: '$items.id',
          name: { $first: '$items.name' },
          image: { $first: '$items.image' },
          purchases: { $push: '$orderTimeDate' } // Store purchase dates
      }},
      // Stage 4: Filter for items purchased more than once and sort purchases descending
      { $addFields: {
          purchases: { $slice: [{ $sortArray: { input: '$purchases', sortBy: -1 } }, 5] } // Last 5 purchases
      }},
      { $match: { 'purchases.1': { $exists: true } } }, // Ensure at least 2 purchases
      // Stage 5: Calculate intervals and other date-based fields
      { $addFields: {
          lastPurchase: { $arrayElemAt: ['$purchases', 0] },
          daysSinceLast: { $divide: [{ $subtract: [now, { $arrayElemAt: ['$purchases', 0] }] }, 1000 * 60 * 60 * 24] },
          intervals: { // Calculate days between consecutive purchases (last 5)
            $map: {
              input: { $range: [0, { $subtract: [{ $size: '$purchases' }, 1] }] },
              as: 'idx',
              in: {
                $divide: [
                  { $subtract: [{ $arrayElemAt: ['$purchases', '$$idx'] }, { $arrayElemAt: ['$purchases', { $add: ['$$idx', 1] }] }] },
                  1000 * 60 * 60 * 24
                ]
              }
            }
          }
      }},
      // Stage 6: Calculate weighted average interval and determine status
      { $addFields: {
          avgInterval: { // Weighted average of the last few intervals
            $let: {
              vars: {
                g1: { $arrayElemAt: ['$intervals', 0] }, // Most recent gap
                g2: { $arrayElemAt: ['$intervals', 1] },
                g3: { $arrayElemAt: ['$intervals', 2] }
              },
              in: {
                $add: [
                  { $multiply: ['$$g1', 0.5] }, // Weight 50% for most recent
                  { $cond: ['$$g2', { $multiply: ['$$g2', 0.3] }, 0] }, // Weight 30% for 2nd most recent
                  { $cond: ['$$g3', { $multiply: ['$$g3', 0.2] }, 0] }  // Weight 20% for 3rd most recent
                ]
              }
            }
          },
          isFrequentlyBought: { $lte: ['$avgInterval', 30] }, // Flag if avg interval <= 30 days
          status: {
            $switch: {
              branches: [
                { case: { $gt: ['$daysSinceLast', { $add: ['$avgInterval', STALE_THRESHOLD_DAYS] }] }, then: 'STALE' },
                { case: { $gte: ['$daysSinceLast', '$avgInterval'] }, then: 'NEEDS_REORDER' },
                { case: { $gte: ['$daysSinceLast', '$avgInterval', REORDER_THRESHOLD] }, then: 'RUNNING_OUT' }
              ],
              default: 'IN_SHELF'
            }
          }
      }},
      // Stage 7: Final projection to shape the output
      { $project: {
          _id: 1, name: 1, image: 1,
          avgInterval: 1, daysSinceLast: 1,
          isFrequentlyBought: 1, status: 1
      }}
    ]);

    res.json(inventory);
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
};
```

**Step 2: Register route in `src/api/server.ts`**

```typescript
// src/api/server.ts
import { handleGetInventory } from './controllers/inventory.controller';
// ... other imports and app setup ...
app.get('/api/inventory', auth, handleGetInventory);
// ... other routes ...
```

**Step 3: Commit**

```bash
git add src/api/controllers/inventory.controller.ts src/api/server.ts
git commit -m "feat: add inventory aggregation API with status, frequent buyer, and stale logic"
```

---

### Task 3: Backend - Knuspr Cart Proxy

**Files:**
- Create: `src/api/controllers/cart.controller.ts`
- Modify: `src/api/server.ts`

**Step 1: Implement `/api/cart/add` proxy controller**
Create the controller that fetches encrypted integration credentials, decrypts them, and proxies the `add-to-cart` request to Knuspr.

```typescript
// src/api/controllers/cart.controller.ts (conceptual snippet)
import { Request, Response } from 'express';
import Integration from '../../models/Integration';
import { decrypt } from '../../lib/crypto'; // Assuming crypto utility is available

export const handleAddToCart = async (req: Request, res: Response) => {
  const { productId, count } = req.body;
  const userId = (req as any).userId; // Assuming userId is available from auth middleware

  if (!productId || !count) {
    return res.status(400).json({ error: 'productId and count are required' });
  }

  try {
    const integration = await Integration.findOne({ userId, provider: 'knuspr' });
    if (!integration) {
      return res.status(404).json({ error: 'Knuspr integration not found. Please connect your account.' });
    }

    // Decrypt headers and cookies
    const headers = JSON.parse(decrypt(integration.encryptedCredentials.headers));
    const cookies = JSON.parse(decrypt(integration.encryptedCredentials.cookies)); // Might be needed for some requests

    // Construct the Knuspr add-to-cart request
    const knusprResponse = await fetch('https://www.knuspr.de/services/frontend-service/metric/add-to-cart', {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        // Potentially reconstruct cookie header if needed, or ensure headers contain it
        // 'Cookie': Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ')
      },
      body: JSON.stringify({
        context: { id: null, type: 'GENERAL' },
        component: { id: null, type: 'PRODUCT_LIST' },
        isAuthenticated: true,
        userId: headers['x-knuspr-userid'] || userId, // Use userId from headers if available, otherwise from auth
        item: { id: productId, type: 'PRODUCT', position: 1, count: count }
      })
    });

    if (!knusprResponse.ok) {
      console.error(`Knuspr API error: ${knusprResponse.status} ${await knusprResponse.text()}`);
      return res.status(knusprResponse.status).json({ error: 'Failed to add to Knuspr cart. Check your connection or integration settings.' });
    }

    res.json({ success: true, message: 'Item added to Knuspr cart!' });
  } catch (error) {
    console.error('Error in handleAddToCart:', error);
    res.status(500).json({ error: 'Internal server error processing add to cart request.' });
  }
};
```

**Step 2: Register route in `src/api/server.ts`**

```typescript
// src/api/server.ts
import { handleAddToCart } from './controllers/cart.controller';
// ... other imports and app setup ...
app.post('/api/cart/add', auth, handleAddToCart);
// ... other routes ...
```

**Step 3: Commit**

```bash
git add src/api/controllers/cart.controller.ts src/api/server.ts
git commit -m "feat: add Knuspr cart reorder proxy with encrypted credentials"
```

---

### Task 4: Frontend - Inventory View

**Files:**
- Create: `src/frontend/pages/Inventory.tsx`
- Modify: `src/frontend/index.tsx`, `src/frontend/App.tsx`

**Step 1: Implement `Inventory.tsx` page**
Create the frontend page with tabs, item cards, status indicators, and the reorder button.

```typescript
// src/frontend/pages/Inventory.tsx (conceptual snippet)
import { createSignal, onMount, For, Show, createEffect } from 'solid-js';
import { ShoppingCart, AlertCircle, RefreshCw, Star } from 'lucide-solid'; // Added Star for frequent buyer
import { useSearchParams } from '@solidjs/router'; // Needed for query params

interface InventoryItem {
  _id: string;
  name: string;
  avgInterval: number;
  daysSinceLast: number;
  isFrequentlyBought: boolean;
  status: 'IN_SHELF' | 'RUNNING_OUT' | 'NEEDS_REORDER' | 'STALE';
}

const REORDER_THRESHOLD = 0.7;
const STALE_THRESHOLD_DAYS = 90;

export function Inventory() {
  const [items, setItems] = createSignal<InventoryItem[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [reordering, setReordering] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal('running-out'); // Default tab
  const [toast, setToast] = createSignal<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchInventory = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/inventory');
      if (res.ok) {
        const data = await res.json();
        // Post-processing to calculate status and flags if not done by backend,
        // or to ensure frontend interpretation aligns with backend.
        // Assuming backend already calculates isFrequentlyBought and status.
        setItems(data);
      } else {
        setError('Failed to fetch inventory items. Please try again later.');
      }
    } catch (e) {
      setError('An error occurred while connecting to the server.');
      console.error('Fetch error:', e);
    } finally {
      setLoading(false);
    }
  };

  const reorder = async (productId: string) => {
    if (reordering()) return;
    
    setReordering(productId);
    try {
      const res = await fetch('/api/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, count: 1 }) // Default count to 1, could be made configurable
      });
      
      if (res.ok) {
        showToast('Successfully added to Knuspr cart!');
      } else {
        const errorData = await res.json();
        showToast(errorData.error || 'Failed to add item to cart.', 'error');
      }
    } catch {
      showToast('Connection error. Could not add to cart.', 'error');
    } finally {
      setReordering(null);
    }
  };

  onMount(fetchInventory);

  // Filter items based on the current tab
  const filteredItems = () => {
    const all = items();
    switch (tab()) {
      case 'running-out':
        return all.filter(i => i.status === 'RUNNING_OUT');
      case 'needs-reorder':
        return all.filter(i => i.status === 'NEEDS_REORDER');
      case 'in-shelf':
        return all.filter(i => i.status === 'IN_SHELF');
      case 'stale':
        return all.filter(i => i.status === 'STALE');
      default:
        return [];
    }
  };

  // Function to determine progress bar color and value logic
  const getProgressBarConfig = (item: InventoryItem) => {
    const progress = Math.min(100, Math.max(0, (item.daysSinceLast / item.avgInterval) * 100));
    let colorClass = 'progress-success'; // Default to green for IN_SHELF
    if (item.status === 'RUNNING_OUT') colorClass = 'progress-warning';
    if (item.status === 'NEEDS_REORDER' || item.status === 'STALE') colorClass = 'progress-error';
    
    // Handle cases where avgInterval might be 0 or very small to avoid division by zero or infinite progress
    const displayProgress = isNaN(progress) || !isFinite(progress) ? 0 : progress;

    return { value: displayProgress, colorClass };
  };

  // Function to get human-readable time remaining
  const getTimeRemaining = (item: InventoryItem) => {
    if (item.status === 'IN_SHELF') return `Approx. ${Math.round(item.avgInterval - item.daysSinceLast)} days left`;
    if (item.status === 'RUNNING_OUT') return `Running out in ~${Math.round(item.avgInterval - item.daysSinceLast)} days`;
    if (item.status === 'NEEDS_REORDER') return `Overdue by ${Math.round(item.daysSinceLast - item.avgInterval)} days`;
    if (item.status === 'STALE') return `Not reordered for ${Math.round(item.daysSinceLast)} days`;
    return '';
  };

  return (
    <div class="space-y-6">
      <div class="flex justify-between items-center">
        <h1 class="text-3xl font-bold">Inventory</h1>
        <button 
          class="btn btn-ghost btn-sm gap-2" 
          onClick={fetchInventory}
          disabled={loading()}
        >
          <RefreshCw size={16} class={loading() ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div class="tabs tabs-boxed">
        <button 
          class={`tab ${tab() === 'running-out' ? 'tab-active' : ''}`} 
          onClick={() => setTab('running-out')}
        >
          Running Out
        </button>
        <button 
          class={`tab ${tab() === 'needs-reorder' ? 'tab-active' : ''}`} 
          onClick={() => setTab('needs-reorder')}
        >
          Needs Reorder
        </button>
        <button 
          class={`tab ${tab() === 'in-shelf' ? 'tab-active' : ''}`} 
          onClick={() => setTab('in-shelf')}
        >
          In Shelf
        </button>
        <button 
          class={`tab ${tab() === 'stale' ? 'tab-active' : ''}`} 
          onClick={() => setTab('stale')}
        >
          Stale Stock
        </button>
      </div>

      <Show when={error()}>
        <div class="alert alert-error shadow-lg">
          <AlertCircle size={20} />
          <span>{error()}</span>
          <button class="btn btn-sm btn-ghost" onClick={fetchInventory}>Retry</button>
        </div>
      </Show>

      <Show when={loading() && items().length === 0}>
        <div class="flex justify-center p-12">
          <span class="loading loading-spinner loading-lg text-primary" />
        </div>
      </Show>

      <Show when={!loading() || items().length > 0}>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <For each={filteredItems()} fallback={
            <div class="col-span-full flex flex-col items-center justify-center p-12 bg-base-100 rounded-xl shadow-sm border border-base-300">
              <div class="text-6xl mb-4">📦</div>
              <h3 class="text-xl font-bold">All clear!</h3>
              <p class="text-base-content/60">No items in this category are currently flagged.</p>
            </div>
          }>
            {(item) => {
              const progressBar = getProgressBarConfig(item);
              return (
                <div class={`card bg-base-100 shadow-xl border ${
                  item.status === 'STALE' ? 'border-gray-400/50' :
                  item.status === 'NEEDS_REORDER' ? 'border-error/50' :
                  item.status === 'RUNNING_OUT' ? 'border-warning/50' :
                  'border-success/50'
                } hover:shadow-2xl transition-shadow`}>
                  <div class="card-body">
                    <div class="flex justify-between items-center">
                      <h2 class="card-title text-lg flex items-center gap-2">
                        {item.name}
                        <Show when={item.isFrequentlyBought}>
                          <span class="tooltip" data-tip="Frequently Bought">
                            <Star class="w-4 h-4 text-yellow-400" />
                          </span>
                        </Show>
                      </h2>
                    </div>
                    <div class="space-y-2 mt-2">
                      <div class="flex justify-between text-xs opacity-60">
                        <span>Usage / Avg. Interval</span>
                        <span>{item.daysSinceLast.toFixed(0)} / {item.avgInterval.toFixed(0)} days</span>
                      </div>
                      <progress 
                        class={`progress w-full ${progressBar.colorClass}`} 
                        value={progressBar.value} 
                        max="100"
                      />
                      <p class="text-xs opacity-70 font-medium">
                        {getTimeRemaining(item)}
                      </p>
                    </div>
                    <div class="card-actions justify-end mt-4">
                      <button 
                        class={`btn btn-primary btn-sm gap-2 ${item.status === 'STALE' ? 'btn-disabled opacity-50' : ''}`} 
                        onClick={() => reorder(item._id)}
                        disabled={reordering() === item._id || item.status === 'STALE'}
                      >
                        <Show when={reordering() === item._id} fallback={<ShoppingCart size={16} />}>
                          <span class="loading loading-spinner loading-xs" />
                        </Show>
                        {reordering() === item._id ? 'Adding...' : 'Reorder'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Toast Notification */}
      <Show when={toast()}>
        <div class="toast toast-end z-50">
          <div class={`alert ${toast()?.type === 'success' ? 'alert-success' : 'alert-error'} shadow-lg text-white`}>
            <Show when={toast()?.type === 'success'} fallback={<AlertCircle size={20} />}>
              <ShoppingCart size={20} />
            </Show>
            <span>{toast()?.message}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}

// src/frontend/index.tsx
// Add Route for /inventory: <Route path="/inventory" component={Inventory} />

// src/frontend/App.tsx
// Add Inventory link to the sidebar navigation.

Step 2: Commit
git add src/frontend/pages/Inventory.tsx src/frontend/index.tsx src/frontend/App.tsx
git commit -m "feat: implement Inventory view with status categories, frequent buyer indicator, and stale stock tracking"
