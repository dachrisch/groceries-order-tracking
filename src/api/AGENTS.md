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

Cart: `POST /api/cart/add` (thin wrapper around `addItems` in
`src/lib/knuspr-cart.ts`).

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
- `Occasion` — learned occasion with per-serving items and source orders.
- `BotRun` — exactly what the bot added and its delivery/undo status.
- `BotSettings` — per-user guardrails and `opencodeEnabled`.

## Tests

`npm test`. Use `setupTestDB`/`clearDB`/`teardownTestDB` from
`__tests__/helpers.ts`. Mock `knuspr-cart`/`knuspr-auth` — no network calls.
