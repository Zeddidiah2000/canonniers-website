# Directive: Normalize responsive breakpoints across alignement.html and faq.html

## Context

Header logo, nav, footer, and content widths drift between pages because Home / Schedule / Live Stream have a complete responsive ladder (1400px and 1800px breakpoints with full treatment) while Roster (`alignement.html`) and FAQ (`faq.html`) are missing rules at those breakpoints. FAQ also uses non-standard mobile breakpoints (768px instead of 820px, no 560px block).

Home, Schedule, and Live Stream are the reference. Do NOT modify them.

This directive modifies two files only:
- `alignement.html`
- `faq.html`

## Reference values (from `index.html`)

```css
/* Base */
.header-inner { padding: 16px 28px; }
.logo-img    { height: 110px; }

/* @media (min-width: 1400px) */
.header-inner { padding: 18px 48px; }
.logo-img    { height: 130px; }
.nav-inner a { font-size: 15px; padding: 15px 20px; }
/* content max-width: 1380px, lang-bar padding 5px 48px */

/* @media (min-width: 1800px) */
.header-inner { padding: 20px 80px; }
.logo-img    { height: 150px; }
.nav-inner a { font-size: 16px; padding: 16px 24px; }
/* content max-width: 1680px, lang-bar padding 6px 80px */

/* @media (max-width: 820px) */
.header-inner { flex-direction: column; padding: 16px; }
/* footer collapses to single column */

/* @media (max-width: 560px) */
.nav-inner a { padding: 10px 8px; font-size: 11px; }
```

---

## Changes to `alignement.html`

### Change 1 — Fix 1400px header padding and add logo scaling

**Find** (around line 143):

```css
    @media (min-width: 1400px) {
      .header-inner { padding: 16px 48px; }
      .nav-inner a { font-size: 15px; padding: 15px 20px; }
      .page-header { padding: 44px 48px 38px; }
      .roster-wrap { max-width: 1380px; padding: 48px 48px 72px; }
      .team-tabs { max-width: 1380px; padding: 0 48px; }
      .footer-inner { max-width: 1380px; } .footer-bottom { max-width: 1380px; }
      .lang-bar { padding: 5px 48px; }
    }
```

**Replace with**:

```css
    @media (min-width: 1400px) {
      .header-inner { padding: 18px 48px; }
      .logo-img { height: 130px; }
      .nav-inner a { font-size: 15px; padding: 15px 20px; }
      .page-header { padding: 44px 48px 38px; }
      .roster-wrap { max-width: 1380px; padding: 48px 48px 72px; }
      .team-tabs { max-width: 1380px; padding: 0 48px; }
      .footer-inner { max-width: 1380px; } .footer-bottom { max-width: 1380px; }
      .lang-bar { padding: 5px 48px; }
    }
```

Two changes: `padding: 16px 48px` → `padding: 18px 48px`, and added `.logo-img { height: 130px; }`.

### Change 2 — Add full 1800px ultrawide block

**Find** (the closing `}` of the 1400px block, immediately followed by the 820px block):

```css
      .lang-bar { padding: 5px 48px; }
    }
    @media (max-width: 820px) {
```

**Replace with**:

```css
      .lang-bar { padding: 5px 48px; }
    }
    @media (min-width: 1800px) {
      .header-inner { padding: 20px 80px; }
      .logo-img { height: 150px; }
      .nav-inner a { font-size: 16px; padding: 16px 24px; }
      .page-header { padding: 56px 80px 44px; }
      .roster-wrap { max-width: 1680px; padding: 56px 80px 88px; }
      .team-tabs { max-width: 1680px; padding: 0 80px; }
      .footer-inner { max-width: 1680px; padding: 0 80px; }
      .footer-bottom { max-width: 1680px; padding-left: 80px; padding-right: 80px; }
      .lang-bar { padding: 6px 80px; }
    }
    @media (max-width: 820px) {
```

### Change 3 — Fix tablet header to stack vertically

**Find**:

```css
    @media (max-width: 820px) {
      .header-inner { padding: 12px 16px; }
      .roster-wrap { padding: 24px 15px 48px; }
```

**Replace with**:

```css
    @media (max-width: 820px) {
      .header-inner { flex-direction: column; padding: 16px; }
      .roster-wrap { padding: 24px 15px 48px; }
```

---

## Changes to `faq.html`

### Change 4 — Add logo scaling at 1400px

**Find** (around line 297):

```css
    @media (min-width: 1400px) {
      .header-inner { padding: 18px 48px; }
      .page-header { padding: 44px 48px 38px; }
```

**Replace with**:

```css
    @media (min-width: 1400px) {
      .header-inner { padding: 18px 48px; }
      .logo-img { height: 130px; }
      .page-header { padding: 44px 48px 38px; }
```

### Change 5 — Add logo scaling at 1800px

**Find**:

```css
    @media (min-width: 1800px) {
      .header-inner { padding: 20px 80px; }
      .nav-inner a { font-size: 16px; padding: 16px 24px; }
```

**Replace with**:

```css
    @media (min-width: 1800px) {
      .header-inner { padding: 20px 80px; }
      .logo-img { height: 150px; }
      .nav-inner a { font-size: 16px; padding: 16px 24px; }
```

### Change 6 — Replace non-standard 768px mobile block with standard 820px + 560px ladder

**Find**:

```css
    @media (max-width: 768px) {
      .nav-inner a { padding: 10px 8px; font-size: 11px; }
      .featured-card { grid-template-columns: 1fr; }
      .featured-gear { grid-template-columns: repeat(4, 1fr); grid-template-rows: 1fr; height: 120px; }
      .featured-content { padding: 24px 20px; }
      .footer-inner { grid-template-columns: 1fr; gap: 16px; }
      .faq-wrap { padding: 28px 16px 48px; }
    }
```

**Replace with**:

```css
    @media (max-width: 820px) {
      .header-inner { flex-direction: column; padding: 16px; }
      .featured-card { grid-template-columns: 1fr; }
      .featured-gear { grid-template-columns: repeat(4, 1fr); grid-template-rows: 1fr; height: 120px; }
      .featured-content { padding: 24px 20px; }
      .footer-inner { grid-template-columns: 1fr; gap: 16px; }
      .faq-wrap { padding: 28px 16px 48px; }
    }
    @media (max-width: 560px) {
      .nav-inner a { padding: 10px 8px; font-size: 11px; }
    }
```

---

## Verification after deploy

After Cloudflare Pages publishes from `main`, hard-refresh (Ctrl+Shift+R) and walk:

`Home → Schedule → Roster → Live Stream → FAQ`

at each of these viewport widths:

- ~375px (small phone)
- ~700px (large phone / small tablet)
- ~1280px (laptop)
- ~1500px (1400px breakpoint active)
- ~1900px (1800px breakpoint active)

The header height, logo size, nav bar height, and content max-width should not jump between pages at any of those widths.

## Out of scope

- `index.html`, `calendrier.html`, `diffusion.html`: untouched.
- `joueur.html`, `guide-diffusion-streaming.html`, `admin.html`: not part of the main nav loop the user described, not changed in this directive.
- Extracting shared CSS into a single file: separate refactor, not this change.
