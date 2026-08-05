# OpenTill brand assets

Standalone files with hardcoded colors, for external use (docs, posts, slides).
In-product rendering uses `apps/web/src/shared/Logo.tsx` + CSS tokens instead.

| File | Use on |
| --- | --- |
| `mark.svg` | Dark surfaces (tray `#f5f5f5`, coin `#f7931a`) |
| `mark-light.svg` | Light surfaces (tray `#0a0a0a`) |
| `lockup-dark.svg` | Dark surfaces — mark + wordmark, font embedded |
| `lockup-light.svg` | Light surfaces |

## Rules

- **Minimums:** lockup ≥ 20px mark height — below that, use the mark alone.
  At ≤ 16px rendered, use the small-size variant paths (see the favicon).
- **Clear space:** one mark-width on all sides of the lockup.
- **Coin** is always Bitcoin orange `#f7931a`; **tray** is `#f5f5f5` on dark,
  `#0a0a0a` on light. Single-color contexts: both shapes (and the whole
  wordmark) in one color — on orange backgrounds, single-color black.

## Don'ts

- No rotation, no outlines/strokes, no gradients, no shadows.
- No ₿ (or anything else) inside the coin; no text in the tray.
- Never close or narrow the 1.5-unit coin/tray gap; never overlap the shapes.
- Don't recolor the coin, don't restyle the wordmark (Space Grotesk 700,
  letter-spacing −0.03em, "Till" in orange — or single-color).
- Don't redraw the geometry — copy these files or the paths verbatim.
