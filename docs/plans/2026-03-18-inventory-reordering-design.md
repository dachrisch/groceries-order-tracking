# Inventory & Automated Reordering Design

**Date:** 2026-03-18  
**Status:** Validated  
**Topic:** Inventory Management and Knuspr Cart Integration  

## 1. Purpose
Transform the application from a passive order tracker into an active household inventory assistant. By analyzing purchase frequency (rebuy intervals), the system will predict when products are running low and allow one-click reordering via the Knuspr API.

## 2. Architecture & Data Flow

### 2.1 Backend: Dynamic Inventory Aggregation
A new API endpoint `GET /api/inventory` will compute product status on-the-fly using a MongoDB aggregation pipeline.

**Aggregation Logic:**
1.  **Filter:** Orders for the authenticated user.
2.  **Unwind:** Flatten `items` arrays.
3.  **Group by Product ID:** Collect all `orderTimeDate` values.
4.  **Lookback (Weighting):**
    *   Limit to the **last 5 purchases** per product.
    *   Calculate intervals (days between purchases).
    *   **Weighted Average Rebuy Interval:** `(gap1 * 0.5) + (gap2 * 0.3) + (gap3 * 0.2)` where `gap1` is the most recent.
5.  **Status Mapping:**
    *   **`IN_SHELF`**: `daysSinceLast < 0.7 * avgInterval`.
    *   **`RUNNING_OUT`**: `0.7 * avgInterval <= daysSinceLast < 1.0 * avgInterval`.
    *   **`NEEDS_REORDER`**: `1.0 * avgInterval <= daysSinceLast < 2.5 * avgInterval`.
    *   **`ARCHIVED`**: `daysSinceLast >= 2.5 * avgInterval` (ignored in main views).

### 2.2 Reorder Proxy (`POST /api/cart/add`)
A backend proxy to handle the Knuspr `add-to-cart` metric request.
*   **Authentication:** Retrieves stored `headers` and `cookies` from the `Integration` model.
*   **Payload:** Constructs the Knuspr-compatible JSON body (UserAgent, userId, productId, count).
*   **Error Handling:** Detects expired sessions and prompts the user to refresh headers in Settings.

## 3. Frontend Components

### 3.1 Inventory View (`/inventory`)
A tabbed interface for managing stock:
*   **Tabs:** "Running Out" (High priority), "Needs Reorder", "In Shelf".
*   **Product Cards:**
    *   **Consumption Bar:** Progress bar showing usage relative to the estimated interval.
    *   **Forecast Label:** "Approx. 3 days remaining" or "Empty for 2 days".
    *   **Reorder Button:** Triggers the Knuspr cart API.

### 3.2 Global Integration
*   **Navigation:** Add "Inventory" to the sidebar with a badge for "Running Out" items.
*   **Dashboard Widget:** A "Quick Reorder" section on the main dashboard for high-urgency items.

## 4. Testing Strategy
*   **Aggregation Tests:** Verify the weighted average calculation with mock purchase dates (regular vs. irregular intervals).
*   **Status Logic:** Ensure products move between categories correctly as time passes.
*   **Proxy Mocking:** Test the reorder proxy by mocking the Knuspr endpoint and verifying header transmission.

## 5. Security & Constraints
*   **Credential Protection:** Stored Knuspr headers must be treated as sensitive (already handled by current backend architecture).
*   **Session Validity:** The system relies on the user occasionally "Importing" orders to keep the `cf_clearance` and `PHPSESSION` cookies fresh.
