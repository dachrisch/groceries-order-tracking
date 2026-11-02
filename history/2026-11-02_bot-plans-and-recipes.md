# 2026-11-02 — Order bot: multi-step requests and learned recipes

## Problem

> "i have pizza event for 6 at wednesday and needs some food till end of the week"
> → "I haven't seen you shop for “pizza” yet. I do not invent recipes, so I will not guess the products."

- The parser returned one intent per message, so the weekly part and both dates were lost.
- Occasion detection needs a special basket repeated twice and had found nothing, so the
  bot refused.
- The history showed yeast, flour and mozzarella (homemade pizza), but nothing used that.

## Solution

1. **Plans:** `parsePlan` returns `{ actions[] }`. The regex fast path splits on and/und/,/;
   and handles each part. The LLM returns dates as the user's words, and `dates.ts`
   resolves them. "till end of week" sets the weekly horizon to Sunday.
2. **One run:** `mergeCandidates` + `executeCandidates` (the only cart writer) add the
   weekly and occasion items once each (larger quantity, joined reasons) as one `BotRun`
   (`intent.type: plan`, `summary`).
3. **Recipes from your own products:** for an unknown dish, opencode returns
   homemade/ready-made ingredients matched by index to the user's product groups (any
   index outside that list is discarded). The app picks the style from the history:
   homemade at ≥60% core coverage with ≥2 core groups bought at least twice. Ingredients
   never bought are listed as missing, not guessed.
4. **Learning:**
   - A new recipe is saved as an `Occasion` draft (`source: recipe`) and confirmed with
     one "yes"; after that it fills directly.
   - `discoverRecipes` runs after sync (at most daily, only when groups changed) and
     suggests dishes with ≥3 regularly bought core ingredients.
   - Deliveries nudge `qtyPerServing` 30% toward the delivered packs when the user
     changed the pack count.
5. **Occasions tab:** drafts/suggestions with Save/Delete, style and evidence, missing
   ingredients, and the last detection's stats when nothing was found.
6. **Eval:** `src/lib/__tests__/fixtures/chat-eval.json` (fast cases checked in CI) and
   `npm run bot:eval` (live LLM score).

## Fixed on the way

`detectOccasions` deleted every non-manual occasion it did not re-detect. That would have
wiped recipes on each sync, so it now only deletes `source: detected`.

## Files

- New: `src/lib/bot/{dates,recipes}.ts`, `scripts/bot-eval.ts`,
  `src/lib/__tests__/{dates,intent,recipes,fill,chat}.test.ts`, `fixtures/chat-eval.json`
- Changed: `src/lib/bot/{intent,chat,fill,occasions,order-matching,consumption}.ts`,
  `src/models/{Occasion,BotRun,BotSettings}.ts`, `src/api/controllers/{bot,settings}.controller.ts`,
  `src/api/app.ts`, `src/frontend/pages/Bot.tsx`, `src/frontend/components/BotPanel.tsx`

## Verification

- `npm test`: 203 passed; `npm run lint`: clean; `npm run build`: ok
- `npm run bot:eval` without a key: 12/14 (the two LLM-only cases need opencode)
- Not yet verified live against opencode and Knuspr.

## Follow-ups

- Knuspr catalog search for ingredients never bought (needs the endpoint captured from DevTools).
- Run `npm run bot:eval` with a key and add every misunderstood real message to the fixture.
