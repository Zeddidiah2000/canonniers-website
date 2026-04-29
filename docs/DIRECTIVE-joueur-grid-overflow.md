# Directive: Fix grid overflow on joueur.html (player detail page)

## Context

On narrow viewports (mobile phones), stat tables on `joueur.html` overflow horizontally and break the page layout. Root cause is the CSS Grid default behavior: grid items have `min-width: auto`, so the right column (containing wide stat tables) refuses to shrink below its content width. The `@media(max-width: 820px)` rule correctly switches the grid to a single column, but without `min-width: 0` on the children, the column still sizes to its content instead of the viewport.

The inner `.table-container` already has `overflow-x: auto` and `width: 100%` set inline (lines 470, 499), so once the grid stops forcing the parent wider, horizontal scrolling will work as intended on the table itself.

This directive modifies `joueur.html` only.

## Change — add `min-width: 0` to grid children

**Find** (around line 256):

```css
    @media(max-width: 820px) {
      .content-wrap { grid-template-columns: 1fr; padding: 24px 15px 64px; }
      .footer-inner { grid-template-columns: 1fr; gap: 16px; }
    }
```

**Replace with**:

```css
    @media(max-width: 820px) {
      .content-wrap { grid-template-columns: 1fr; padding: 24px 15px 64px; }
      .content-wrap > * { min-width: 0; }
      .footer-inner { grid-template-columns: 1fr; gap: 16px; }
    }
```

That is the entire fix. One added line.

## Why this is enough

- `min-width: 0` on the grid children lets them shrink below their content's natural width.
- `.stat-section` already has `overflow: hidden` defined at line 196 (existing CSS, do not duplicate).
- `.table-container` already has `width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch;` set inline on every instance (do not duplicate as a stylesheet rule).
- No new breakpoint introduced. Existing 820px and 560px breakpoints are sufficient and match the rest of the site.

## Verification

After deploy and hard refresh, on a phone in portrait (~375–414px wide) load any player detail page. Page should not horizontally scroll. Stat tables should scroll horizontally inside their own container while the page itself stays put.

## Out of scope (flagged but not changed)

`joueur.html` is also missing the 1400px and 1800px large-screen breakpoints that were just added to Roster and FAQ. Same class of drift bug, separate fix. Not addressed here to keep this change minimal and verifiable.
