# Bulk Pricing Fetch Implementation Plan

**Goal:** Refactor `inventory.controller.ts` to use bulk API requests for product pricing.

**Architecture:** Replace iterative per-item fetch with chunked bulk requests to `https://www.knuspr.de/api/v1/products/prices`.

---

### Task 1: Refactor inventory.controller.ts

**Files:**
- Modify: `src/api/controllers/inventory.controller.ts`

**Step 1: Replace fetchEnhancedMetadata with bulk fetch**

Remove `fetchEnhancedMetadata` and replace it with a bulk processing loop:

```typescript
    // Fetch current prices from Knuspr if session is available
    let session: string | null = null;
    try {
      session = await getKnusprSession(userId, req.derivedKey);
    } catch (e) {
      console.warn('Failed to get Knuspr session for inventory prices:', e);
    }

    if (session) {
      const productIds = inventory.map(item => item._id);
      const chunkSize = 50;
      
      for (let i = 0; i < productIds.length; i += chunkSize) {
        const chunk = productIds.slice(i, i + chunkSize);
        try {
          const queryString = chunk.map(id => `products=${id}`).join('&');
          const res = await fetch(`https://www.knuspr.de/api/v1/products/prices?${queryString}`, {
            headers: {
              'Cookie': `PHPSESSION_de-production=${session}`,
              'x-origin': 'WEB',
            },
          });
          
          if (res.ok) {
            const priceData = await res.json();
            // priceData is an array of objects
            priceData.forEach((p: any) => {
              const item = inventory.find(i => i._id === p.productId);
              if (item) {
                // Use sale price if active, else original price
                const activeSale = p.sales?.find((s: any) => s.active);
                item.currentPrice = activeSale ? activeSale.price.amount : p.price.amount;
              }
            });
          }
        } catch (e) {
          console.error(`Failed to fetch bulk pricing for chunk ${i}:`, e);
        }
      }
    }
```

---

### Task 2: Verify

**Step 1: Run inventory tests**

Run: `npm test src/api/__tests__/inventory.test.ts`
Expected: Tests should pass (might need slight adjustment to match the new API structure).

---
