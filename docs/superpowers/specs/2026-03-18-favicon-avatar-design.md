# Favicon & Avatar Design Spec

**Date:** 2026-03-18

## Goal

Add a pretzel favicon to the browser tab and replace the letter-initial user avatar with a pretzel icon in the app sidebar.

---

## Favicon

**Choice:** Emoji/Unicode SVG (Option A)

**File:** `public/favicon.svg`

Render the 🥨 Unicode character (U+1F968) as an SVG `<text>` element. No raster images, no external dependencies. Scales perfectly at all browser tab sizes.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <text y=".9em" font-size="90">🥨</text>
</svg>
```

**index.html change:** Add a single `<link>` tag in `<head>`:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
```

---

## User Avatar

**Choice:** Pretzel icon (Option B)

Replace the first-initial letter placeholder with the 🥨 pretzel in both avatar locations in `App.tsx`:

1. **Desktop sidebar** (bottom-left user card) — currently `<span class="text-sm font-bold">{user()?.name?.[0]?.toUpperCase()}</span>` inside a `w-10` circle
2. **Mobile drawer** (bottom user block) — currently `<span>{user()?.name?.[0]?.toUpperCase()}</span>` inside a `w-8` circle

Replace the `<span>` content in both with the pretzel emoji: `<span>🥨</span>`

No sizing, color, ring, or layout changes — only the content inside the circle changes.

---

## Files Changed

| File | Change |
|------|--------|
| `public/favicon.svg` | New file — pretzel emoji SVG |
| `index.html` | Add `<link rel="icon">` tag |
| `src/frontend/App.tsx` | Replace 2× initial span with pretzel emoji span |

---

## Out of Scope

- No Apple touch icon or PWA manifest changes
- No per-user avatar upload or customization
- No color changes to the avatar circle background
