# src/api — backend

## Layout

- `app.ts` — builds the Express app and registers every route. Import `app`
  in tests; `server.ts` only starts it.
- `controllers/` — one file per area: `auth`, `order`, `inventory`, `cart`,
  `settings`, `bot`.
- `utils.ts` — `JWT_SECRET`, the `auth` middleware, `derivedKeyMiddleware`
  (decrypts the Knuspr credential key from the session cookie) and
  `formatZodError`.
- `__tests__/` — supertest tests plus `helpers.ts` (`setupTestDB`, `clearDB`,
  `teardownTestDB`, CSRF helpers, user helpers).

## Request rules

- Every `/api/*` route except auth and `/api/csrf-token` uses `auth`, which
  injects `req.userId` from the JWT cookie.
- State-changing requests need a CSRF token (`x-csrf-token`) and the CSRF
  cookie. Tests must fetch both with `fetchCsrf()`.
- Validate request bodies with zod and return `400` via `formatZodError`.
- Knuspr sessions need `req.derivedKey`; use `requireKey()` in the bot
  controller, and return `401` when it is missing.
- Never throw raw errors to the client; log server-side and return
  `{ error: string }`.

## Routes

Auth: `POST /api/register`, `POST /api/login`, `POST /api/logout`,
`GET /api/session`.

Reads: `GET /api/stats`, `/api/aggregates`, `/api/orders`,
`/api/orders/:id`, `/api/products/:id/price`, `/api/product-trends`,
`/api/inventory`, `/api/cart`.

Merged reads (both sources, `controllers/browse.controller.ts`,
`activity.controller.ts`, `location.controller.ts`):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/products` | merged list; `statsByProvider` is keyed per provider and never averaged, `?due=1`, `?source=knuspr\|edeka` |
| PUT | `/api/product-links` | `{ knusprProductId, edekaTextKey \| null }` — a manual cross-store correction; `null` deletes it |
| GET | `/api/search?q=` | own history (instant) + EDEKA `searchMeta` (25 cap, `truncated`); `knuspr.state` is `later` until a catalogue search exists. Needs at least 2 characters |
| GET | `/api/activity` | deliveries and in-store runs as one newest-first stream; `?from&to&provider&limit`, totals per source over the returned events |
| GET | `/api/activity/:id` | one entry with lines; the id is `knuspr:<orderId>` or `edeka:<sessionId>` |
| GET | `/api/location` | context, per-provider availability with a reason, and the derived destination |
| PUT | `/api/location` | `homeCity`, `homeCountry`, `awayWindows`; an unknown location keeps both sources available |

The merged read model lives in `src/lib/purchases.ts` (events) and
`src/lib/providers.ts` (location and reach). `src/lib/product-stats.ts` builds
one stat per provider. Search never calls `ensureSession` for a user with no
integration row: typing a query must not sign an account up.

### The cross-store link is display only

`GET /api/products` can show "you also buy this at EDEKA" on a Knuspr row: the
EDEKA `ProductStat` and offer are attached to that item and the bucket no longer
appears as its own `edeka:` row. That is the *only* effect.

- Two mechanisms, deliberately separate. A manual correction is a
  `ProductLink` row (`{ userId, knusprProductId, edekaTextKey, confidence,
  source: 'manual' }`, unique on `(userId, knusprProductId)`) written by
  `PUT /api/product-links`; `edekaTextKey: null` removes it. An automatic match
  is computed on every read by `resolveLinks` (`src/lib/product-links.ts`) from
  `normalizeName` / `nameSimilarity` / `sizeCompatible`, accepted only at
  similarity ≥ 0.8 with compatible pack sizes, and **never stored**. Below the
  floor the row stays unlinked; the shopper can still link it by hand. A manual
  row beats an automatic one and carries confidence 1.
- One EDEKA bucket backs at most one Knuspr row, so the same receipt row cannot
  appear twice.
- **Nothing on the row is derived from the EDEKA side.** `due` and `stockDays`
  stay Knuspr-only: an in-store cadence describes a different shop run and would
  double-count a week that had both. No rate, stock, occasion or anything the bot
  learned may read a `ProductLink` — `src/lib/bot/**` is lint-forbidden from
  importing the model (invariant D5), and
  `src/lib/__tests__/product-links.test.ts` asserts that
  `getWeeklyConsumption` output is byte-identical before and after a link is
  stored.

Cart: `POST /api/cart/add` (thin wrapper around `addItems` in
`src/lib/knuspr-cart.ts`).

Basket (`controllers/basket.controller.ts`, contract in `src/lib/basket.ts`):
one request shape for both stores, with the server — not the UI — deciding
whether the destination is reachable.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/basket/add` | `{ destination, items[] }` → `{ status, runId, added, skipped: [{ name, reason }], total, destination, guardrail }`; `409` when the provider cannot reach the location or the guardrails would be exceeded (nothing is written) |
| POST | `/api/basket/undo/:runId` | undo in the store the run was written to → `{ undone, restored }`; `409` when the run is no longer open, `502` when the store did not remove every line |

`items[]` is `{ provider, productId?, textKey?, name, qty }`. A Knuspr cart
line needs `productId`; an EDEKA line may be free text (`textKey` + `name`).
Guardrails (`maxEuro`, `maxItems` from `getBotSettings`) apply to both
adapters; the EDEKA list carries no prices, so only `maxItems` can refuse it.
Availability is checked with `getLocationSettings` + `resolveLocation` +
`availability()`, so a hand-made request for an unreachable destination never
reaches a basket.

EASY Shopper (in-store, `src/lib/easyshopper/AGENTS.md`):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/easyshopper/import-purchases` | sidecar upload; idempotent on `key`, clears a pending sync |
| GET | `/api/easyshopper/purchases` | stored sessions + per-store summary |
| GET | `/api/easyshopper/insights` | spend/units/products aggregated deterministically |
| POST | `/api/easyshopper/list/extract` | opencode vision reads a list photo; `202 {jobId}`, `400` oversized/invalid image, `429` a read is already running for this user, `503` opencode is unconfigured |
| GET | `/api/easyshopper/list/extract/:id` | poll one photo read: `{status, lines, model, paid, error}`; `404` `that photo read was lost — read the photo again` |
| POST | `/api/easyshopper/list/plan` | search + opencode match (rules fallback), no writes; `lines` max 60 × 200 chars, `useModel: false` forces the rules plan |
| POST | `/api/easyshopper/list/create` | write the plan to the account's list, then mint a share link (plans again, so the preview is advisory) |
| GET | `/api/easyshopper/share-code` | the account's `userGuid` — payload of the Aztec code the phone scans |
| POST | `/api/easyshopper/list/share` | (re)mint the 24 h invite link |
| POST | `/api/easyshopper/sync/request` | flag a capture for the laptop sidecar |
| GET | `/api/easyshopper/sync/status` | pending request, last import, last purchase |

The EASY Shopper integration keeps its own anonymous device credentials encrypted in
`Integration` (`provider: easyshopper`); `list/plan`, `list/create`, `list/share` and
`sync/request` need `req.derivedKey` and return 401 without it. `list/extract` needs no
store key: it only reads a photo. Photo reads are asynchronous because a vision call takes
tens of seconds; the job registry is in memory, so it lives in one process and does not
survive a restart (`src/lib/easyshopper/AGENTS.md`).

Bot:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/bot/message` | Start a chat job; returns `{ jobId }` |
| GET | `/api/bot/jobs/:id` | Poll a chat job |
| POST | `/api/bot/fill-week` | Execute the weekly fill (UI button) |
| GET | `/api/bot/forecast` | Dashboard weekly estimate + month occasions |
| GET | `/api/bot/occasions` | Learned occasions |
| POST | `/api/bot/occasions/detect` | Re-run occasion detection |
| POST | `/api/bot/occasions/discover` | Suggest recipes from the groceries you buy (forced) |
| GET | `/api/bot/occasions/diagnostics` | Stats of the last detection (why nothing was found) |
| POST | `/api/bot/occasions/:id/confirm` | Save a draft recipe (then it fills without asking) |
| DELETE | `/api/bot/occasions/:id` | Delete an occasion or recipe |
| GET | `/api/bot/occasions/:id` | One occasion |
| POST | `/api/bot/occasions/:id/fill` | Fill an occasion for N servings (confirms a draft) |
| GET | `/api/bot/runs` | Recent `BotRun`s |
| POST | `/api/bot/runs/:id/undo` | Best-effort cart undo |
| GET | `/api/bot/groups` | Product groups with products |
| POST | `/api/bot/groups/merge` | Create/merge a manual group |
| POST | `/api/bot/groups/:id/split` | Remove a product from a manual group |
| GET/PUT | `/api/bot/settings` | Guardrails + opencode toggle |

Integrations: `GET /api/settings/integrations`,
`POST/DELETE /api/settings/integrations/knuspr`,
`POST /api/settings/integrations/knuspr/sync`.

The sync route runs the whole learning pipeline: rebuild product groups →
detect occasions → match bot runs to orders → tag occasion orders.

## Models (`src/models/`)

- `User` — auth fields + encrypted Knuspr credentials.
- `Order` — imported Knuspr order with nested items; also `botRunId`,
  `botRunItemCount`, `botRunDeliveredCount`, `occasionIds[]`.
- `Integration` — connected providers and last sync time.
- `ProductGroup` — `{ userId, key, label, productIds[], manual }`.
- `ProductLink` — a manual cross-store display correction
  (`{ userId, knusprProductId, edekaTextKey, confidence, source: 'manual' }`).
  Never read by learning code; see "The cross-store link is display only".
- `Occasion` — learned occasion with per-serving items and source orders.
- `BotRun` — exactly what the bot added and its delivery/undo status, plus
  `destination` (`knuspr-cart` default, `edeka-list`, `checklist`) and the
  `locationContext` (`source`, `city`, `country`) it was derived from. The item
  schema keeps the Knuspr `productId` but also allows an EDEKA `textKey` and the
  returned `listItemGuid`, so undo can address a list row.
- `BotSettings` — per-user guardrails and `opencodeEnabled`, plus the location
  half (`homeCity`, `homeCountry`, `awayWindows`) read by `/api/location`.

## Tests

`npm test`. Use `setupTestDB`/`clearDB`/`teardownTestDB` from
`__tests__/helpers.ts`. Mock `knuspr-cart`/`knuspr-auth` — no network calls.
`basket.test.ts` mocks both baskets (Knuspr cart helpers and the EASY Shopper
client) and covers the location gate, the guardrails, CSRF and undo. The lib
counterpart is `src/lib/__tests__/basket.test.ts`.
