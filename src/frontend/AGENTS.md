# src/frontend — SolidJS app

## Layout

- `index.tsx` — router and page routes. Five destinations, plus redirects for
  the old paths (`/products`, `/inventory`, `/orders`, `/in-store`), and the
  `/bot` and `/lists` entry pages that open an overlay over a destination.
- `App.tsx` — root layout: session check, desktop drawer, mobile bottom tabs,
  search and location headers. Mounts `AskHub`, `ListFlow`, `SearchOverlay` and
  `BotPanel` so Ask, the shopping list, search and location are reachable from
  every page.
- `pages/` — the five destinations: `Overview` (two-rate week card, due cards,
  recent activity and month spend), `Groceries` (one product list over both
  sources, with the product sheet), `Activity` (merged timeline plus bot runs),
  `Settings`, `Login`, `Register`. The legacy bodies the merge replaced
  (`Dashboard`, `Orders`, `Products`, `Inventory`, `Bot`, `InStore`) were
  deleted. `AskEntry` and `ListsEntry` are bookmark shims that open their
  overlay and replace the history entry.
- `components/StatePanel.tsx` — the one shape for every non-happy path: title,
  reason, at most one action. A disabled action always renders its
  `disabledReason`; never a greyed button without an explanation.
- `components/CapturePanel.tsx` — "waiting for phone" / "capture is stale" for
  Overview and Activity. A capture is a request to the phone sidecar (T4), so it
  never shows a spinner; Settings owns the full card.
- `components/AskHub.tsx` — the Ask sheet: Chat | Occasions | Groups.
  `components/ask/` holds the panes; `ChatPane` owns the job protocol.
- `components/Sheet.tsx` — the shared bottom-sheet/desktop-panel primitive.
- `components/ListFlow.tsx` — the EDEKA shopping list sheet: typed or
  photographed lines, the matches, then the Aztec share code. Activity opens it
  with "New list", Groceries when the destination is the EDEKA list or a
  checklist, and `/lists` over Activity. The photo outcomes (read by a paid
  model, every line ticked, unreadable, an unmatched line kept as free text)
  each have their own copy; the share copy states the swap before the code.
- `components/ProductSheet.tsx` — one product with a stat row per provider, its
  offers, the EDEKA display match and the group merge/split corrections.
- `components/BasketAddButton.tsx` — the one `+`: posts `/api/basket/add` and
  shows the server's `409` reason instead of pre-judging availability.
- `components/ProviderBadges.tsx` — the K/E chips used by every merged page.
- `components/SearchOverlay.tsx` — one query over history, EDEKA and Knuspr.
- `components/LocationChip.tsx` — city chip plus the read-only "Where are you?"
  sheet.
- `components/BotPanel.tsx` — the desktop chat drawer, also built on `ChatPane`.
- `lib/location.tsx` — the one `GET /api/location` read, shared through context.
- `lib/browse.ts` — wire types for `GET /api/products` and the lookups that keep
  a stat keyed per provider (`addTargetFor`, `offerFor`, `providersOf`).
- `lib/activity.ts` — wire types for `/api/activity`, plus month-range helpers.
- `lib/format.ts` — money, date and cadence formatting (no provider logic).
- `lib/request.ts` — `fetchWithTimeout` (15 s) and the failure copy. Every page
  read goes through it so a hung request ends in "Try again" instead of a
  spinner with no way out.
- `lib/sync.ts` — the one reading of the EDEKA capture state (`waiting`,
  `connected`, `offline`) plus the seven-day staleness threshold.
- `lib/overlays.ts` — signals that let any surface open Ask, search or the
  shopping-list flow.
- `index.css` — Tailwind 4 + DaisyUI theme.

## Conventions

- SolidJS, not React: use `createSignal`, `onMount`, `<Show>`, `<For>`; props
  are accessed as functions (`props.value`) and JSX has no virtual DOM.
- Every page fetches its own data with `fetch('/api/...')` in `onMount`, except
  location, which the shell reads once and exposes via `useLocation()`.
- A rate is always attributable (plan §2 D1, invariant 7). `statsByProvider` is
  keyed per provider and no page may render one merged figure; the week card
  and the activity summary show one figure per store.
- A `+` goes through `POST /api/basket/add` with the location's destination.
  Availability and guardrails are the server's decision: the button shows the
  `409` reason, it does not pretend to be the guard.
- Use DaisyUI classes (`card`, `btn`, `badge`, `stats`, `alert`, `input`)
  and the existing rounded/soft visual language. Icons come from
  `lucide-solid`.
- Chat is job-based: `POST /api/bot/message` returns a `jobId`, then
  `ChatPane` polls `GET /api/bot/jobs/:id`. Keep the polling and progress
  state there, not in a drawer or a hub pane.
- After a bot run, dispatch/observe the `bot-run-complete` event so other
  pages (cart drawer, inventory) can refresh. `ChatPane`, `OccasionsPane` and
  `BasketAddButton` dispatch it; `Overview`, `Groceries`, `Activity` and
  `OccasionsPane` listen.
- Empty is a state, not a missing fallback: use `StatePanel` and name the reason
  and one action. "Nothing due", "nothing in this range" and "no products yet"
  are different states with different ways out. A shopping list whose lines are
  all ticked is a *success* with nothing to add, not a "nothing found".
- Pages that show bot state: `pages/Activity` (timeline entry + Runs tab),
  `pages/Overview` (week card), `Groceries`/`ProductSheet` ("Fill week" and
  due counts), `Settings.tsx` (bot guardrails).

## Checks

`npm run typecheck` is the type check (`npm run build` only builds: vite and
esbuild strip types without checking them, and CI does not type-check yet).
`npm run lint` catches lint issues.
