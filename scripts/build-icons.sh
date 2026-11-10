#!/usr/bin/env bash
# Regenerates every raster icon + the macOS .icns from assets/icon.svg (needs rsvg-convert and iconutil, macOS).
set -euo pipefail
cd "$(dirname "$0")/../src/electron/renderer/assets"
for s in 512 256 128 32; do rsvg-convert -w $s -h $s icon.svg -o icon-$s.png; done
rsvg-convert -w 16 -h 16 icon.svg -o favicon-16.png
rm -rf icon.iconset && mkdir icon.iconset
for s in 16 32 128 256 512; do
  rsvg-convert -w $s -h $s icon.svg -o icon.iconset/icon_${s}x${s}.png
  rsvg-convert -w $((s*2)) -h $((s*2)) icon.svg -o icon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset
