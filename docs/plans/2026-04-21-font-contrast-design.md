# Design: Improved Font Contrast & Readability

This design improves the readability of the application by strengthening the base text colors and refining transparency levels across all pages, while maintaining the "Organic Market" aesthetic.

## Section 1: Global Design System (index.css)

We will update `src/frontend/index.css` to define a strong base text color and ensure it's applied correctly to all content.

- **Base Content Color**: We'll define `--color-base-content: #2d2a24;` in the `:root`. This is a dark, warm earthy brown that provides high contrast against the `#f7f4ed` background.
- **Root Application**: Both `html` and `body` will explicitly set `color: var(--color-base-content)`.
- **Heading Styles**: All headings (`h1` through `h6`) will be updated to use `color: var(--color-neutral)` (#5c5346) by default, ensuring they are always clearly visible.
- **Utility Classes**: We'll refine the `.page-title` class to match the `h1` styling used in the pages for a more cohesive look.

## Section 2: Opacity & Transparency Refinement

We've identified several areas where low-contrast text is caused by excessive transparency. We'll refine these systematically:

- **Bumping Values**:
  - `opacity-30` (barely visible) → `opacity-60` (clearly visible but still distinct)
  - `opacity-50` → `opacity-75`
  - `opacity-60` → `opacity-85`
- **Tailwind Alpha Updates**:
  - `/60` (on text) → `/85`
  - `/50` → `/75`
  - `/30` → `/60`
- **Icon Refinement**:
  - In the sidebar (`App.tsx`), we'll change `text-primary/70` and others to `/90` or remove transparency, as these are the main navigation cues.

These changes ensure all UI elements are easily distinguishable while maintaining the "soft, organic" feeling of the design.

## Section 3: Implementation Strategy

1.  **Phase 1: Global CSS Update**
    - Modify `src/frontend/index.css` with the new `:root` variables and base styles.
2.  **Phase 2: Global Search and Replace**
    - Use `grep` and `sed` to replace the opacity/alpha values across all `.tsx` files in `src/frontend`.
3.  **Phase 3: Component-Specific Check**
    - Manually review `Inventory.tsx` and `App.tsx` for any remaining low-contrast text that wasn't covered by global rules.

By the end of this work, the application will have significantly higher contrast and readability across all pages, while retaining its warm, earthy color scheme.
