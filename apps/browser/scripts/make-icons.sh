#!/usr/bin/env bash
# Regenerate every icon from assets/icon.svg. Needs ImageMagick (`magick`); the .icns step
# needs macOS `iconutil`. Outputs: assets/icon.png (1024), icon.icns (macOS), icon.ico (Windows).
set -euo pipefail
cd "$(dirname "$0")/../assets"
magick -background none -density 384 icon.svg -resize 1024x1024 icon.png
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
if command -v iconutil >/dev/null; then
  rm -rf icon.iconset && mkdir icon.iconset
  for s in 16 32 128 256 512; do
    magick icon.png -resize ${s}x${s} icon.iconset/icon_${s}x${s}.png
    magick icon.png -resize $((s*2))x$((s*2)) icon.iconset/icon_${s}x${s}@2x.png
  done
  iconutil -c icns icon.iconset -o icon.icns
  rm -rf icon.iconset
fi
ls -la icon.*
