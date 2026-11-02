# src/frontend — SolidJS app

## Layout

- `index.tsx` — router and page routes.
- `App.tsx` — root layout: session check, sidebar nav, cart/bot drawers.
  Mounts `<BotPanel />` so chat is available on every page.
- `pages/` — `Dashboard`, `Orders`, `Products`, `Inventory`, `Bot`,
  `Settings`, `Login`, `Register`.
- `components/BotPanel.tsx` — the app-wide chat drawer.
- `index.css` — Tailwind 4 + DaisyUI theme.

## Conventions

- SolidJS, not React: use `createSignal`, `onMount`, `<Show>`, `<For>`; props
  are accessed as functions (`props.value`) and JSX has no virtual DOM.
- Every page fetches its own data with `fetch('/api/...')` in `onMount`.
  There is no global store.
- Use DaisyUI classes (`card`, `btn`, `badge`, `stats`, `alert`, `input`)
  and the existing rounded/soft visual language. Icons come from
  `lucide-solid`.
- Chat is job-based: `POST /api/bot/message` returns a `jobId`, then
  `BotPanel` polls `GET /api/bot/jobs/:id`. Keep the polling and progress
  state inside the panel.
- After a bot run, dispatch/observe the `bot-run-complete` event so other
  pages (cart drawer, inventory) can refresh.
- Pages that show bot state: `Bot.tsx` (Runs / Occasions / Groups tabs),
  `Inventory.tsx` ("Fill week"), `Orders.tsx` (bot + occasion badges),
  `Dashboard.tsx` (forecast card), `Settings.tsx` (bot guardrails).

## Checks

`npm run build` is the type/build check. `npm run lint` catches lint issues.
