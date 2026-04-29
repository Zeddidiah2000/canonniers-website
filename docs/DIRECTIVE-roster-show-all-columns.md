# Directive: Remove column-hiding rule from alignement.html roster table

## Context

The 560px media query on `alignement.html` hides the Ht (height) and Wt (weight) columns from the roster table on small phones. Decision is to show all six columns on all viewports and rely on the existing `.table-container` horizontal scroll wrapper (already present in the markup at line 299) to handle overflow.

This directive modifies `alignement.html` only. One rule deleted. No other changes.

## Change — delete column-hiding rule

**Find**:

```css
    @media (max-width: 560px) {
      .nav-inner a { padding: 10px 8px; font-size: 11px; }
      .roster-table thead th:nth-child(n+5),
      .roster-table tbody td:nth-child(n+5) { display: none; }
    }
```

**Replace with**:

```css
    @media (max-width: 560px) {
      .nav-inner a { padding: 10px 8px; font-size: 11px; }
    }
```

That is the entire change. The `.nav-inner a` rule stays. The two-selector column-hiding rule is removed.

## Why this is enough

- The table is already wrapped in `<div class="table-container" style="width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; ...">` at line 299, so horizontal scrolling on overflow is already in place.
- No new CSS rules needed. No `overflow-x: auto` added to `.roster-section` (would be the wrong element anyway).
- No font-size or padding changes — those are separate decisions.

## Verification

After deploy and hard refresh, on a phone in portrait (~375px wide):

- All six columns (#, Player, Pos., B/T, Ht, Wt) should be visible
- Table should scroll horizontally inside the `.table-container` when content exceeds viewport width
- Page itself should not horizontally scroll (the `.table-container` contains the overflow)
- Nav links should still have the smaller padding/font from the `.nav-inner a` rule

## If the live file differs from what's shown above

If the current 560px block on `main` doesn't match the `Find` text (e.g. additional rules were added since the breakpoint directive), do NOT proceed. Report the actual current contents of the block and a corrected directive will be issued.
