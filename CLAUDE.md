# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Run frontend (port 5173) + backend (port 3000) concurrently
npm run dev:frontend # Vite dev server only
npm run dev:backend  # Express backend with tsx watch only
npm run build        # Production frontend build
npm run serve        # Preview production build
```

No test or lint commands are configured yet.

## Architecture

Full-stack groceries order tracker for Knuspr (German online supermarket). Users import their order history via a cURL command copied from browser DevTools; the backend parses the headers/cookies and fetches all delivered orders from the Knuspr API.

**Stack:** SolidJS + Vite frontend, Express + Mongoose backend, MongoDB Atlas.

**Frontend** (`src/frontend/`): SolidJS SPA with `@solidjs/router`. Routes are defined in `index.tsx`. `App.tsx` is the root layout — it checks session, shows the sidebar nav, and wraps all pages. Each page fetches its own data independently (no global store). Tailwind + DaisyUI for styling.

**Backend** (`src/api/`): Single Express server (`server.ts`) that mounts controllers. Auth uses JWT stored in httpOnly cookies (7-day expiry). The `authMiddleware` injects `userId` into the request for all protected routes.

**Data flow for import:**
1. User pastes a cURL command from Knuspr on the Import page
2. `POST /api/import` parses headers/cookies from the cURL string
3. Backend paginates `https://www.knuspr.de/api/v3/orders/delivered` (limit=20, offset increments)
4. Orders + items are upserted into MongoDB (unique index on `userId + orderId`)
5. Knuspr credentials are saved to the user document for future re-imports

**Key API endpoints:**
- `POST /api/import` — parse cURL, fetch and store Knuspr orders
- `GET /api/stats` — aggregate totals (spend, items, orders)
- `GET /api/aggregates` — monthly breakdown `{year, month, totalAmount, orderCount}`
- `GET /api/orders` — all orders (items excluded for payload size)
- `GET /api/orders/:id` — single order with full items array
- `GET /api/product-trends` — per-product price history across orders

**Models** (`src/models/`):
- `User` — stores auth fields + `knusprCredentials: { headers, cookie, lastImport }`
- `Order` — stores full Knuspr order with nested `items[]` array; compound unique index `(userId, id)`

**Lib** (`src/lib/`):
- `mongodb.ts` — Mongoose connection (URI currently hardcoded, should use `MONGODB_URI` env var)
- `order-importer.ts` — cURL parsing + Knuspr API pagination logic

## Known Issues

- MongoDB URI and JWT secret are hardcoded — move to environment variables before any production use
- User Knuspr credentials (headers/cookies) stored in MongoDB unencrypted
