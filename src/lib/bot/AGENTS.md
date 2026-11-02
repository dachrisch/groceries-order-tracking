# src/lib/bot — learning and cart pipeline

## The one rule

Statistics do the learning. opencode only turns text into JSON (a plan of
actions, occasion names/servings, recipe ingredients). It gets no tools and no
database access, and its output must never introduce a product ID: recipe
matches are indices into the user's own product-group list and are validated
against that list. Dates come back as the user's words and are resolved by
`dates.ts`. Every cart mutation is deterministic
code and must be unit-testable without network access.

## Modules

| File | Responsibility |
| --- | --- |
| `product-groups.ts` | Rules-only grouping: leaf category + size bucket + name similarity (union-find). Manual groups survive rebuilds. |
| `consumption.ts` | Weekly model: ≥3 distinct weeks, median interval with 2.5× staleness cutoff, time-decayed rate (8-week half-life), stock/horizon quantity, occasion exclusions. |
| `occasions.ts` | Candidate baskets → co-occurrence clusters (support ≥2, lift ≥1.2, Jaccard merge) → opencode naming → `Occasion`. Also fuzzy matching, per-serving fill and chat corrections. |
| `fill.ts` | `FillCandidate` + `mergeCandidates` (per group: max qty, joined reasons), `executeCandidates` (the only cart writer: skip in-cart, `chooseVariant`, guardrails, `addItems`, `BotRun`), `planWeeklyFill` (optional `horizonDays`). |
| `intent.ts` | `parsePlan`: message → `{ actions[] }` (weekly with `until`, occasion with `date`, correction, confirm). Regex fast path splits on and/und/,/; and handles each part; opencode for the rest. `comparePlan` scores against the eval fixture. |
| `dates.ts` | Deterministic date phrases (EN/DE weekdays, today/morgen, end of week/Wochenende, next week, ISO, dd.mm.) and `horizonDaysUntil`. |
| `recipes.ts` | Dish → homemade/ready-made variants from opencode, matched to the user's groups. The app picks the style: homemade at ≥60% core coverage with ≥2 core groups bought ≥2×. Saved as `Occasion` `source: recipe` `status: draft`. `discoverRecipes` (after sync, ≤ daily, only when groups changed) suggests dishes with ≥3 regularly bought core ingredients. |
| `chat.ts` | Runs a plan: clear actions execute at once as one `BotRun`; unknown dishes become recipe drafts; one "yes" confirms drafts and guardrail overruns together. |
| `jobs.ts` | In-memory job registry polled by the frontend. |
| `order-matching.ts` | Match delivered orders to open `BotRun`s; tag occasion orders; nudge recipe `qtyPerServing` 30% toward delivered packs when the user changed the pack count (`learnedQtyPerServing`). |

Supporting libs: `../opencode-client.ts` (session → prompt → poll → JSON),
`../knuspr-cart.ts` (add/remove/check/prices/normalize),
`../knuspr-auth.ts` (session login).

## Pipeline

Sync → `rebuildProductGroups` → `detectOccasions` (stores `BotSettings.lastDetection`
stats; only deletes `source: detected` occasions) → `matchRunsToOrders` (+ recipe
learning) → `tagOccasionOrders` → `discoverRecipes` (background, not awaited).

Chat: `parsePlan` → per action: weekly (`until` → horizon), confirmed occasion,
or draft (existing draft/suggestion, else `resolveRecipe`) → confirmed actions
→ `mergeCandidates` → `executeCandidates` (one run) → reply lines + drafts.
Drafts never reach the cart before a "yes" (chat) or Save/Fill (Occasions page).

Weekly fill: `getWeeklyConsumption` (occasion purchases excluded) → due items
→ skip anything already in the cart → `chooseVariant` → guardrails → `addItems`
→ `BotRun`.

Occasion fill: match by name/alias → core items only → `ceil(qtyPerServing ×
servings / packSize)` → if the same group is also due weekly, use
`max(occasionQty, weeklyQty)` and add once.

## Tests

`src/lib/__tests__/` covers grouping, consumption, occasion detection/matching,
order matching, recipes, dates, plan parsing, the chat flow (cart and LLM
mocked) and the opencode client. `fixtures/chat-eval.json` holds real chat
messages with the plan each should produce: `fast: true` entries must parse
without the LLM (CI), `fast: false` ones are scored live by `npm run bot:eval`
(needs `OPENCODE_*`). Add every misunderstood real message there. Use synthetic histories; never call
Knuspr. When changing a threshold or formula, update the corresponding test and
say why in the commit message.
