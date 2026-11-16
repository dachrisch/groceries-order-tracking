# src/frontend — SolidJS app

## Layout

- `index.tsx` — router and page routes. Five destinations, plus redirects for
  the old paths (`/products`, `/inventory`, `/orders`, `/in-store`, `/bot`).
- `App.tsx` — root layout: session check, desktop drawer, mobile bottom tabs,
  search and location headers. Mounts `AskHub`, `SearchOverlay` and `BotPanel`
  so Ask, search and location are reachable from every page.
- `pages/` — `Overview` (Dashboard for now), `Groceries` (Products + Inventory
  placeholder), `Activity` (Orders + In-store placeholder), `Settings`, `Login`,
  `Register`, plus the legacy bodies they wrap (`Dashboard`, `Orders`,
  `Products`, `Inventory`, `Bot`, `InStore`).
- `components/AskHub.tsx` — the Ask sheet: Chat | Occasions | Groups.
  `components/ask/` holds the panes; `ChatPane` owns the job protocol.
  Occasions and Groups used to live only on `pages/Bot.tsx`.
- `components/Sheet.tsx` — the shared bottom-sheet/desktop-panel primitive.
- `components/SearchOverlay.tsx` — one query over history, EDEKA and Knuspr.
- `components/LocationChip.tsx` — city chip plus the read-only "Where are you?"
  sheet.
- `components/BotPanel.tsx` — the desktop chat drawer, also built on `ChatPane`.
- `lib/location.tsx` — the one `GET /api/location` read, shared through context.
- `lib/overlays.ts` — signals that let any surface open Ask or search.
- `index.css` — Tailwind 4 + DaisyUI theme.

## Conventions

- SolidJS, not React: use `createSignal`, `onMount`, `<Show>`, `<For>`; props
  are accessed as functions (`props.value`) and JSX has no virtual DOM.
- Every page fetches its own data with `fetch('/api/...')` in `onMount`, except
  location, which the shell reads once and exposes via `useLocation()`.
- Use DaisyUI classes (`card`, `btn`, `badge`, `stats`, `alert`, `input`)
  and the existing rounded/soft visual language. Icons come from
  `lucide-solid`.
- Chat is job-based: `POST /api/bot/message` returns a `jobId`, then
  `ChatPane` polls `GET /api/bot/jobs/:id`. Keep the polling and progress
  state there, not in a drawer or a hub pane.
- After a bot run, dispatch/observe the `bot-run-complete` event so other
  pages (cart drawer, inventory) can refresh. `ChatPane` and `OccasionsPane`
  dispatch it; `Inventory`, `pages/Bot` and `OccasionsPane` listen.
- Pages that show bot state: `Bot.tsx` (Runs), `Inventory.tsx` ("Fill week"),
  `Orders.tsx` (bot + occasion badges), `Dashboard.tsx` (forecast card),
  `Settings.tsx` (bot guardrails).

## Checks

`npm run typecheck` is the type check (`npm run build` only builds: vite and
esbuild strip types without checking them, and CI does not type-check yet).
`npm run lint` catches lint issues.
