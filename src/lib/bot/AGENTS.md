# src/lib/bot — learning and cart pipeline

## The one rule

Statistics do the learning. opencode only turns text into JSON (intent,
occasion names/servings). It gets no tools and no database access, and its
output must never introduce a product ID. Every cart mutation is deterministic
code and must be unit-testable without network access.

## Modules

| File | Responsibility |
| --- | --- |
| `product-groups.ts` | Rules-only grouping: leaf category + size bucket + name similarity (union-find). Manual groups survive rebuilds. |
| `consumption.ts` | Weekly model: ≥3 distinct weeks, median interval with 2.5× staleness cutoff, time-decayed rate (8-week half-life), stock/horizon quantity, occasion exclusions. |
| `occasions.ts` | Candidate baskets → co-occurrence clusters (support ≥2, lift ≥1.2, Jaccard merge) → opencode naming → `Occasion`. Also fuzzy matching, per-serving fill and chat corrections. |
| `fill.ts` | `planWeeklyFill`, `executeWeeklyFill`, `chooseVariant` (deal-aware), guardrails, `BotRun` creation. |
| `intent.ts` | Fast regex parser for common commands; opencode fallback for the rest. |
| `chat.ts` | Orchestrates intents, pending confirmations, last occasion and replies. |
| `jobs.ts` | In-memory job registry polled by the frontend. |
| `order-matching.ts` | Match delivered orders to open `BotRun`s; tag occasion orders. |

Supporting libs: `../opencode-client.ts` (session → prompt → poll → JSON),
`../knuspr-cart.ts` (add/remove/check/prices/normalize),
`../knuspr-auth.ts` (session login).

## Pipeline

Sync → `rebuildProductGroups` → `detectOccasions` → `matchRunsToOrders` →
`tagOccasionOrders`.

Weekly fill: `getWeeklyConsumption` (occasion purchases excluded) → due items
→ skip anything already in the cart → `chooseVariant` → guardrails → `addItems`
→ `BotRun`.

Occasion fill: match by name/alias → core items only → `ceil(qtyPerServing ×
servings / packSize)` → if the same group is also due weekly, use
`max(occasionQty, weeklyQty)` and add once.

## Tests

`src/lib/__tests__/` covers grouping, consumption, occasion detection/matching,
order matching and the opencode client. Use synthetic histories; never call
Knuspr. When changing a threshold or formula, update the corresponding test and
say why in the commit message.
