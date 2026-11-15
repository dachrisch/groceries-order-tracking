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
| `choose.ts` | `buildMatchPrompt` / `readPicks` / `chooseWithModel`: one batched text call that offers each line's candidate **names by positional index**. A pick outside that line's menu is discarded and the rules score stands; the model's `why` never decides anything. `ChooseOptions` cannot express a photo or a paid call, so `allowPaid` is unreachable at this call site. Budgeted: `timeoutMs: 20_000`, `maxModels: 3`. |
| `list.ts` | `searchListCandidates` builds one scored, deduped menu per line → `buildPlan` (rules) → `applyPicks` (model picks inside that menu), composed by `planShoppingList`; `rerankWithHistory` corrects a weak *rules* line with what the user bought before and never outranks a model pick. |
| `extract.ts` | `extractListLines`: one opencode vision call for a photographed list — free vision models first, the curated paid tier only as a fallback (`allowPaid`). The reply is validated into `ListLine`s: a legible line is never dropped, only its quantity falls back to 1. It never sees or picks products. |
| `extract-jobs.ts` | The in-memory registry behind `POST /list/extract`: at most one running read per user, a 2-minute deadline per job, a 1 h TTL and 5 jobs/user, and error text written for the shopper. One process only. |
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
   `searchListCandidates` builds one menu per line — catalogue search results plus recent
   purchases, scored, deduped and capped at 8 — and that single array is the prompt's
   order, `readPicks`' bound and `applyPicks`' index. The model may only point at a row
   in it; the candidate object and its id always come from the menu this backend built,
   never from the reply, and an index outside the line's own menu is dropped. The rules
   score is the pre-filter and the fallback when opencode is unconfigured, rate-limited
   or answers with something else.
   Recent purchases are part of that menu, so the model may pick one on its own merits;
   `rerankWithHistory` is only the correction for a weak rules line, not a second opinion
   that outranks the model. A purchase collapses into a catalogue row only when it is the
   *same* product: pack size, percentage and parentheticals are identity ("H-Milch 3,5 %"
   stays next to "H-Milch 1,5 %", "laktosefrei" next to the ordinary carton), and a
   purchase with no evidence for the line never *evicts* a catalogue row — it can only
   fill a slot the catalogue left empty.
4. **Store scoping.** Prices, categories and lists are per store GUID. A plan without a
   store is meaningless.
5. **The photo leaves the server; the backend still owns the menu and the ids.** Photo
   intake is one opencode vision call (`extract.ts`): the image is downscaled in the
   browser, is never written to Mongo, never logged, and is not kept by the job — only the
   lines it produced are. The model returns list lines and nothing else; it never sees the
   catalogue, never picks a product, and matching (`choose.ts`, `match.ts`) is unchanged
   by how the lines were typed or read.

## Photo intake (opencode vision)

`POST /list/extract` stores a job and answers `202`; the UI polls the job while the vision
chain runs. Operational limits, because a vision chain can reach a paid model:

- **One running read per user.** A second request answers `429`; a settled job is the only
  thing a new read may evict (5 jobs/user, 1 h TTL).
- **A 2-minute deadline per job.** `extractListLines` cannot be cancelled, so the
  in-flight model call may still finish — and cost money — after its job has settled.
- **In memory, one process.** A restart or a second instance answers `404` ("read the
  photo again"); there is no shared store.
- **Errors are written for the shopper.** `NO_READABLE_LIST`, the deadline message and
  one generic retry hint; a provider error is logged, never shown.

Decisions worth knowing before changing this:

- **Photo intake ignores the per-user `opencodeEnabled` toggle, deliberately.**
  `BotSettings` gates *text* calls (chat, occasions, recipes); a photographed list cannot
  be read any other way, so the button stays and a click explains the `503` when opencode
  is unconfigured. Typed lines always plan and match.
- **`/list/create` plans again**, so the shopper's preview is advisory: a re-roll can pick
  differently. Accepting the client's own plan back is a follow-up.
- **The paid tier is visible.** The job carries the answering `model` and `paid`, and the
  UI shows "read by `<model>` (paid)"; otherwise a fallback would only appear on an
  invoice.

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

`src/lib/__tests__/easyshopper-{client,match,choose,extract,extract-jobs,insights,capture-parse}.test.ts`
and `src/api/__tests__/easyshopper.test.ts` (photo intake: `202` + poll, `404` for someone
else's or a lost job). `easyshopper-extract.test.ts` feeds the synthetic fixture photo
`src/lib/__tests__/fixtures/shopping-list.png` through the prompt shape and mocks
`runPrompt`; `opencode-client.test.ts` owns the vision chain and the paid tagging
(one attempt, kill switch, pin). The client tests stub `fetch`; never call the real API
or a real model from a test. Purchases must stay out of the Knuspr `Order` collection and
out of `consumption.ts` unless a caller explicitly opts in.
