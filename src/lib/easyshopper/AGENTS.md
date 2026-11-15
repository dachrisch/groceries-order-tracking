# src/lib/easyshopper — EDEKA / EASY Shopper (Whiz-Cart)

In-store side of the app: purchase history read out of the phone, and shopping lists
written through the integration's own EASY Shopper device account.

Read `docs/easyshopper-api.md` first (local, gitignored) — it is the reverse-engineered
API map this module is built on. Nothing here is guessed: every path and payload
shape comes from the shipped app's own bytecode.

## Modules

| File | Responsibility |
| --- | --- |
| `client.ts` | REST client: `signup` → `login` (Basic `secret:deviceId`) → bearer; legal acceptance; `/v6/searchMeta` body builder; v7 list reads, `createLink`, and `addOrUpdate` upserts. |
| `match.ts` | Deterministic line → product matching (token coverage + size compatibility). No LLM, no I/O. |
| `choose.ts` | `buildMatchPrompt` / `readPicks` / `chooseWithModel`: opencode picks a product **by position** from the menu the backend built for that line (catalogue search + recent purchases, deduped, scored, capped at 8). An index outside that line's menu is discarded and the rules score stands. Budgeted: one call, `timeoutMs: 20_000`, `maxModels: 3`. |
| `list.ts` | `searchListCandidates` → `buildPlan` (rules) → `applyPicks` (opencode), composed by `planShoppingList`; `rerankWithHistory` corrects a weak *rules* line with what the user bought before, and never overrides a model pick. |
| `ocr.ts` | tesseract over a photo of a handwritten list. Local, no network. Being replaced by `extract.ts`. |
| `extract.ts` | `extractListLines`: one opencode vision call for a photographed list, free models first and the curated paid tier only as a fallback. The reply is validated into `ListLine`s; it never picks products. A legible line is never dropped; only its quantity falls back to 1. |
| `insights.ts` | Deterministic spend/units/product aggregates: store-name merging, deposit returns kept separate, POS summary lines excluded. |
| `capture-parse.ts` | Pure parsers for the purchase screens (money, rows, reconciliation) with unit tests. |

## Rules

1. **The account is not the user's account.** It is an anonymous device identity minted
   by `/v4/signup`, stored encrypted in `Integration` (`provider: easyshopper`). It can
   never read the phone's account; that is why purchase history comes from the capture
   sidecar and lists reach the phone through a share link the user follows.
2. **Deletion is `amount: 0`.** `addOrUpdate` is the only item mutation; there is no
   delete endpoint. The app keeps a row when `amount > 0` and drops it otherwise.
3. **Match, don't invent.** A line that does not clear the score threshold stays a
   free-text row. Never fabricate a product id or borrow one from another store.
   opencode may *choose* from the menu (`choose.ts`) but only by index: the candidate
   object always comes from that menu — catalogue search results plus recent purchases
   this backend fetched, never from the model — and an index outside the line's menu is
   ignored. The rules score is the pre-filter and the fallback when opencode is down,
   rate-limited or answers with something else.
   Recent purchases are part of that menu, so the model may pick one on its own merits;
   `rerankWithHistory` is only the correction for a weak rules line, not a second opinion
   that outranks the model. A purchase collapses into a catalogue row only when it is the
   *same* product: pack size, percentage and parentheticals are identity ("H-Milch 3,5 %"
   stays next to "H-Milch 1,5 %", "laktosefrei" next to the ordinary carton), and a
   purchase with no evidence for the line never *evicts* a catalogue row — it can only
   fill a slot the catalogue left empty.
4. **Store scoping.** Prices, categories and lists are per store GUID. A plan without a
   store is meaningless.
5. **The photo exception is explicit.** `AGENTS.md` says opencode gets text only; a photo
   of handwriting cannot be text. A photographed list goes to a vision model
   (`extract.ts`, free first, paid only as a fallback) that may only return list lines —
   never the catalogue, never a product choice. The older local tesseract path (`ocr.ts`)
   did the same job offline; `match.ts` stays deterministic either way.

## Verified against production (2026-11-14)

The chain was executed end to end, so these are facts rather than inferences:
signup → login → validate → legal acceptance → `searchMeta` (`"milch"`: 522 results,
25 items, 30 groups) → one auto-created list → `addOrUpdate` → `createLink`.

**`createLink` answers `text/plain` with a bare URL**, not JSON:

```
https://feature-app-links.easy-shopper-com.pages.dev/app/es-prod/shopping-list-invite?shoppingListGuid=<guid>&token=<uuid>
```

It is the app's verified App Link, so opening it (or its QR) launches EASY Shopper on
the invite screen. Tokens last 24 h — mint on demand, never cache a link for later.

## Purchase history (capture)

`scripts/easyshopper-capture.ts` drives the phone over adb and reads the "My Purchases"
screens. It is the only source of real purchases; see the repo skill
`.claude/skills/easyshopper-capture/SKILL.md` for the operational details (unlock,
screen timeout, "More" pagination, reconciliation).

Units vs rows: the `ITEMS` header counts **units**, so a receipt with 28 rows and
`€7.99 x 3` reports 36. Reconcile against the sum of quantities, and against the total.

## Tests

`src/lib/__tests__/easyshopper-{client,match}.test.ts` and
`src/api/__tests__/easyshopper.test.ts`. The client tests stub `fetch`; never call the
real API from a test. Purchases must stay out of the Knuspr `Order` collection and out
of `consumption.ts` unless a caller explicitly opts in.
