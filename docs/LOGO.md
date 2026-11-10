# figmake-sync logo and app icon

Master: `src/electron/renderer/assets/icon.svg` (1024 canvas, 824px macOS-grid tile, dark gradient).
Glyph: an orange cap and purple pill over a green dot and a blue D, with `>`, `<` and `/` marks
for pull, push and code.

Regenerate every PNG, the favicon and `icon.icns` from the SVG with `scripts/build-icons.sh`
(needs `rsvg-convert` and macOS `iconutil`). Windows uses `icon-256.png`.
