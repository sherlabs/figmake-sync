# figmake-sync logo and app icon

## Concept: the zipper

Two columns of teeth, meshing. The left column is the local folder, the right column is the
Figma Make project. The teeth interleave the way a zipper closes: two copies of the same thing
kept in step, tooth by tooth. One tooth is in the accent colour. That tooth is the diff: the
line that currently differs and is about to travel across.

It is deliberately not an arrows-in-a-circle sync glyph, not a copy/duplicate icon, and borrows
nothing from Figma's own mark. Read as a texture at 16 px it is a pair of columns with one hot
row; at 512 px it is five rounded pills.

## Construction

Everything is built on a 16-unit canvas and scaled by 64 to the 1024 px master. All numbers
below are canvas units unless noted.

| Element              | Value                                      | Notes                                                          |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Canvas               | 16 x 16                                    | 1 unit = 1 px at the favicon size                              |
| Stroke               | 2 (12.5 % of side)                         | The only stroke weight in the system; 2 real pixels at 16 px   |
| Tile radius          | 2.816 (17.6 % of side)                     | 180.224 px at 1024                                             |
| Glyph box            | 10 x 10, x 3..13, y 3..13                  | 62.5 % of the tile                                             |
| Local column         | 3 teeth, centre-lines x 4..7, y = 4, 8, 12 | Round caps extend the ink to x 3..8                            |
| Figma column         | 2 teeth, centre-lines x 9..12, y = 6, 10   | Ink spans x 8..13; the two columns meet exactly at x = 8       |
| Row pitch            | 4 (2 ink, 2 air)                           | Every edge is on an integer row at 16 px                       |
| Optical nudge        | glyph shifted up 0.5                       | Mass sits low; 2.5 above, 3.5 below. 1 px at 32, 32 px at 1024 |
| Accent tooth         | local column, middle (y = 8)               | The only coloured element                                      |
| 16 px hinting        | butt caps, extended 1 unit, no nudge       | `favicon-16.png` only; keeps the ends from going grey           |
| macOS icon margin    | 100 px transparent on 1024 (tile = 824, 80.5 %) | `icon.icns` only, so the dock icon sits at Apple's visual size. Radius stays 17.6 % (squarer than Apple's ~22.5 % template) by design |
| Bare mark viewBox    | 640 x 640 (= 10 units)                     | `logo-mark-*.svg`                                              |

Scaled to the 1024 master the SVG is literally:

```
rect 0 0 1024 1024 rx 180.224
ink   M256 224H448  M256 736H448  M576 352H768  M576 608H768   stroke 128, round caps
accent M256 480H448                                           stroke 128, round caps
```

Trust-the-eye decisions: the nudge is 0.5 rather than a computed centroid; the columns are
3 + 2 rather than 3 + 3 because the asymmetry is what makes it read as a zipper rather than a
list, and 3 + 3 pushed the glyph box to 75 % of the tile.

## Wordmark

`figmake-sync`, lowercase, drawn as paths with the same 2-unit stroke and round caps
(no font, no licence to carry). x-height 10 = mark height, ascenders to -5, descenders to +5.
The mark sits on the x-height band, 6 units to the left of the `f`. Letter and tooth strokes
are therefore the same weight at any size. No accent appears in the wordmark.

## Colours

| Role         | Light                | Dark                 |
| ------------ | -------------------- | -------------------- |
| Paper (tile) | `#ffffff`            | `#17191d`            |
| Ink          | `#14171c`            | `#eceef2`            |
| Accent       | `#d9641a`            | `#d9641a` (same)     |

Dark paper and ink are the app's own `--surface` and `--text` values, so the header mark
matches the surface it sits on.

WCAG relative-luminance contrast ratios (computed, not guessed):

| Pair                               | Ratio    | Threshold                   |
| ---------------------------------- | -------- | --------------------------- |
| Ink light on paper light           | 17.96 : 1 | passes everything          |
| Ink dark on paper dark             | 15.15 : 1 | passes everything          |
| Accent on paper light (`#ffffff`)  | 3.63 : 1 | >= 3 : 1 graphical objects |
| Accent on paper dark (`#17191d`)   | 4.85 : 1 | >= 3 : 1 graphical objects |
| Accent vs ink light                | 4.95 : 1 | (never adjacent)           |
| Accent vs ink dark                 | 3.12 : 1 | (never adjacent)           |

One accent was chosen that clears 3 : 1 on both papers so the same orange ships in both
themes. The app's own UI accents were checked and rejected: `#3550d6` is 6.42 : 1 on white
but 2.74 : 1 on `#17191d`; `#93a7ff` is 7.72 : 1 on the dark paper but 2.28 : 1 on white, so
each would need a theme-specific variant. The orange is also a warm complement to the cool
grey UI and keeps the mark away from Figma's purple-blue.

## Usage rules

- Clearance: keep at least one tooth height (2 units, i.e. 20 % of the mark's height) of empty
  space around the mark; around the tile, one tile-radius.
- Minimum size: mark 16 px; tile 16 px; wordmark lockup 160 px wide (the lockup is 134.7
  units wide, so at 160 px one unit is 1.19 px: x-height ~ 12 px, stroke ~ 2.4 px).
- Never recolour the accent and never add a second accent. In a one-colour context (engraving,
  monochrome print) every tooth is ink, including the middle one.
- Never put the light tile on a white surface without a hairline; use the bare mark instead.
- Do not rotate, skew, outline, add gradients, shadows or glows, or change the 3 + 2 arrangement.
- Light/dark: `logo-mark-light.svg` is dark ink for light surfaces; `logo-mark-dark.svg` is
  light ink for dark surfaces. Same for the wordmark files.

## Files

All in `src/electron/renderer/assets/`:

- `icon.svg` — full-bleed tile, 1024 master (favicon in `index.html`).
- `icon-32.png`, `icon-128.png`, `icon-256.png`, `icon-512.png` — full-bleed tile
  (Windows installer icon, `BrowserWindow.icon`, apple-touch-icon).
- `favicon-16.png` — hinted 16 px tile.
- `icon.icns` — macOS bundle icon; built with `iconutil` from a 10-image iconset rendered off
  the padded master.
- `logo-mark-light.svg`, `logo-mark-dark.svg` — bare mark, transparent.
- `logo-wordmark-light.svg`, `logo-wordmark-dark.svg` — mark + wordmark lockup, transparent.

## Rejected concepts

Rendered at 16 / 32 / 128 and judged on screen.

1. Two overlapping outlined squares, overlap filled in accent — it is the universal
   copy/duplicate icon; also the accent became the largest shape.
2. Two offset bars with a short accent delta — reads as `=` or a pair of sliders; the accent
   detail vanished at 16 px.
3. Two solid tiles under an accent staple — the staple was the biggest element (accent as
   structure, not detail) and the silhouette is headphones / a magnet. A later variant with an
   ink staple and a floating accent chip read as a robot face.
4. Two interlocked square hooks — dense chain-link, muddy at 16 px, and a hyperlink attractor.
5. Two panes sharing an accent seam — a split-view / book glyph.
6. Two solid tiles with an accent dot between — clean but anonymous (a domino, a divider);
   dog-eared "file" tiles helped but still generic.
7. Two tiles on a short accent rail — a smiley face.
8. Two tiles offset vertically with a connector — a flowchart edge between two nodes.
9. Split-diff ledger (four dashes, one accent) — the right story, but it is a generic list grid
   and rows went grey at 16 px. The zipper is this idea with the two columns interleaved so the
   relationship between them is visible.

Within the zipper, the accent on the right-bottom tooth (the "arrived" change) was tried and
rejected because at 16 px the orange sat off-balance in the corner; the centre row reads as the
heart of the mark.
