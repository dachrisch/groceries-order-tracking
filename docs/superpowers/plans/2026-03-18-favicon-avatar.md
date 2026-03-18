# Favicon & Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pretzel emoji favicon to the browser tab and replace the letter-initial user avatar with a pretzel icon throughout the app.

**Architecture:** Three file changes — a new SVG file in `public/`, one `<link>` tag in `index.html`, and two span replacements in `App.tsx`. No logic changes, no new dependencies.

**Tech Stack:** SolidJS, Vite (serves `public/` as static assets), Tailwind + DaisyUI

---

## File Map

| Action | File | Change |
|--------|------|--------|
| Create | `public/favicon.svg` | Pretzel emoji SVG |
| Modify | `index.html` | Add `<link rel="icon">` |
| Modify | `src/frontend/App.tsx` | Replace 2× initial `<span>` with pretzel `<span>` |

---

### Task 1: Add pretzel favicon

**Files:**
- Create: `public/favicon.svg`
- Modify: `index.html`

Note: the `public/` directory does not exist yet — create it.

- [ ] **Step 1: Create `public/favicon.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <text y=".9em" font-size="90">🥨</text>
</svg>
```

- [ ] **Step 2: Add favicon link to `index.html`**

In the `<head>` section, after the existing `<meta>` tags, add:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
```

Full `<head>` after change:
```html
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#000000" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>Groceries Order Tracking</title>
</head>
```

- [ ] **Step 3: Verify in browser**

Run: `npm run dev`

Open http://localhost:5173 and check the browser tab — it should show the 🥨 pretzel as the favicon.

- [ ] **Step 4: Commit**

```bash
git add public/favicon.svg index.html
git commit -m "feat: add pretzel emoji favicon"
```

---

### Task 2: Replace user avatar initial with pretzel

**Files:**
- Modify: `src/frontend/App.tsx` (lines 105–106 and 168)

There are two avatar locations. Both use a circle `<div>` with a `<span>` inside containing the user's first initial. Replace the `<span>` content in both with the pretzel emoji.

- [ ] **Step 1: Replace desktop sidebar avatar (line ~106)**

Find:
```tsx
<div class="bg-primary text-primary-content rounded-full w-10 shadow-sm ring-2 ring-primary/10">
  <span class="text-sm font-bold">{user()?.name?.[0]?.toUpperCase()}</span>
</div>
```

Replace with:
```tsx
<div class="bg-primary text-primary-content rounded-full w-10 shadow-sm ring-2 ring-primary/10">
  <span>🥨</span>
</div>
```

- [ ] **Step 2: Replace mobile drawer avatar (line ~168)**

Find:
```tsx
<div class="bg-neutral text-neutral-content rounded-full w-8"><span>{user()?.name?.[0]?.toUpperCase()}</span></div>
```

Replace with:
```tsx
<div class="bg-neutral text-neutral-content rounded-full w-8"><span>🥨</span></div>
```

- [ ] **Step 3: Verify in browser**

Run: `npm run dev`

Log in and check:
- Desktop (≥1024px width): bottom-left sidebar shows 🥨 in the primary-color circle
- Mobile (<1024px width): open the drawer, check the bottom user block shows 🥨

- [ ] **Step 4: Commit**

```bash
git add src/frontend/App.tsx
git commit -m "feat: replace user avatar initial with pretzel icon"
```
