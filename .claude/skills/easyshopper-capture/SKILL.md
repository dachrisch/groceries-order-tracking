---
name: easyshopper-capture
description: Read EDEKA / EASY Shopper in-store purchase history off an Android phone over adb and import it into the groceries backend. Use when someone asks to sync EDEKA purchases, refresh in-store history, or debug a capture run that returns too few items.
---

# Capturing EASY Shopper purchase history

The phone's account cannot be read from outside: the app is not debuggable, there is
no root, `adb backup` returns an empty archive on Android 12+, and the app trusts no
user certificate so a proxy cannot decrypt it. What *is* readable is the **screen**,
which renders the whole receipt.

Read-only: the script taps, scrolls and presses back. It never adds, changes or buys
anything.

## Prerequisites

- `adb` on PATH, host authorised, wireless or USB debugging on.
- Phone **unlocked** (a secure lockscreen cannot be dismissed over adb).
- The EASY Shopper app installed (`com.pentlandfirth.whizcart`).
- `tesseract` with `deu` only matters for the OCR list path, not for capture.

## Run

```bash
npm run easyshopper:capture                     # all sessions -> ~/.local/share/groceries/easyshopper/purchases.json
npm run easyshopper:capture -- --dry-run        # list sessions only
npm run easyshopper:capture -- --limit 2        # smoke test
npm run easyshopper:capture -- --serial 192.168.178.22:38009
```

The serial is optional: the script prefers a wireless transport and reconnects via
`adb mdns services` when the port changed (wireless debugging picks a new port on every
restart, so a saved host:port goes stale).

Import the result:

```bash
curl -X POST http://localhost:3000/api/easyshopper/import-purchases \
  -b cookies.txt -H 'x-csrf-token: …' -H 'Content-Type: application/json' \
  -d @<(jq '{sessions}' ~/.local/share/groceries/easyshopper/purchases.json)
```

Import is idempotent: sessions are keyed by `date+time|store|total`, so re-running a
capture never duplicates.

## How it navigates

`PROFILE` tab → `My Purchases` → tap each row. It finds tabs and rows by text, so a
language change is fine, but a redesigned screen needs the selectors updated.

## Gotchas that cost real debugging time

1. **`ITEMS` counts units, not rows.** A 28-row receipt with `€7.99 x 3` reports 36.
   Reconcile on the sum of quantities and on the total; the script prints warnings.
2. **"More" is a pager, not a scroll.** The detail list renders ~5 rows then a `More`
   button. Scrolling without tapping it stops at 5 items forever.
3. **The detail screen reuses the previous receipt while loading.** Its header is
   identical apart from the date, so the script waits for the *expected date* before
   reading. Without that guard, items from the previous session leak in and totals
   stop reconciling.
4. **Screen timeout kills the run.** The script raises `screen_off_timeout` to 30 min
   and restores it afterwards; a 2-minute stock timeout aborts mid-receipt.
5. **The receipt barcode is only available ~24 h after the purchase**, and is a
   centred 22-digit number, not the paragraph below it. Recent sessions therefore
   capture `receiptBarcode: null` — re-run later to fill them.
6. **Deposit returns (Leergut/Pfand) are rows too, with a negative price** —
   `Leergut, -€7.95, -€7.95 x 1`. They must parse (they count toward `ITEMS` and
   reduce `TOTAL`), but they are not purchases: they are stored with `isCredit: true`.
   A price regex that rejects the leading minus silently loses a unit from every
   session that returned bottles.
7. **A stray swipe can pull down the notification shade**, after which every dump is
   system UI. The script collapses the shade before navigating.

## Verifying a run

Every captured session should satisfy, in the script's own output:

- `lines/units` matches the `ITEMS` header, and
- `Σ lineTotal == TOTAL` (tolerance €0.02).

Anything else is printed as a reconciliation warning — investigate, don't ignore:
discounts, deposits (Pfand) and missed rows all show up here.

Every session also carries the verdict: `reconciled` (boolean) and `difference`
(`Σ lineTotal − TOTAL`). The header is authoritative — an imperfect capture is kept and
flagged rather than dropped, so the learning layer can tell a complete receipt from a
partial one. On the first full run: 21/22 reconciled, one receipt missing a €0.84 row.

## Triggering a sync from the web UI

The server cannot reach the phone, so the UI leaves a flag and the worker on this
machine picks it up:

```bash
GROCERIES_URL=http://localhost:3000 GROCERIES_EMAIL=… GROCERIES_PASSWORD=… \
  npm run easyshopper:sync                # poll every 60 s
npm run easyshopper:sync -- --once        # single pass
```

"Sync now" on the EDEKA page sets `syncRequestedAt`; the worker runs the capture,
uploads it and the backend clears the flag. Run the worker under systemd or a logged-in
terminal — it needs the adb connection and an unlocked phone.

## Share links expire after 24 hours

`createLink` returns a fresh invite URL each call and the list stores `linkToken` +
`linkExpiration`. Never keep a link for a later day: mint it when the list is about to
be used ("New link" on the page). An expired token makes the app show
`api_error_shoppingList_linkToken_expired` — "Der Link ist abgelaufen."

## Shape of the output

```jsonc
{
  "capturedAt": "…",
  "device": "192.168.178.22:38009",
  "sessions": [{
    "key": "11/13/2026 04:50 PM|MARKTKAUF MUSTERSTADT|107.19",
    "displayWhen": "11/13/2026, 04:50 PM",
    "purchasedAt": "2026-11-13T15:50:00.000Z",
    "store": "Edeka Musterstadt (MUSTERSTR.)",
    "type": "CART",
    "paymentMode": "EASY Shopper Cashier",
    "receiptBarcode": "0012345678901234567890",
    "itemCount": 36,
    "total": 107.19,
    "reconciled": true,
    "difference": 0,
    "items": [{ "brand": "Kneipp", "name": "Dusche 200ml Gute Laune", "quantity": 1, "unitPrice": 2.95, "lineTotal": 2.95, "isCredit": false, "raw": "…" }]
  }]
}
```

`raw` keeps the exact rendered row so a parser fix can be replayed without another
capture run. Keep the file off git: it is personal purchase data.
