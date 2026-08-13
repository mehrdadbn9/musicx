#!/usr/bin/env bash
# Regenerate MusicX icons: diagonal violet->magenta tile, rounded corners,
# white X monogram. Pure ImageMagick MVG (IM's internal SVG renderer drops
# linearGradient, so we build the gradient with -define gradient:angle).
set -euo pipefail
cd "$(dirname "$0")/.."

icon() {
  local size="$1" out="$2"
  local r stroke c
  r=$(awk "BEGIN{printf \"%.0f\", $size*15/64}")
  stroke=$(awk "BEGIN{printf \"%.1f\", $size*9/64}")
  c=$(awk "BEGIN{printf \"%.1f\", $size*21.5/64}")
  local e
  e=$(awk "BEGIN{printf \"%.1f\", $size*42.5/64}")
  convert -size "${size}x${size}" -define "gradient:angle=115" gradient:'#a855f7'-'#ec4899' \
    \( -size "${size}x${size}" xc:none -fill white -draw "roundrectangle 0,0 $((size-1)),$((size-1)) ${r},${r}" \) \
    -alpha off -compose CopyOpacity -composite \
    -stroke white -strokewidth "${stroke}" -fill none \
    -draw "stroke-linecap round line ${c},${c} ${e},${e}" \
    -draw "stroke-linecap round line ${e},${c} ${c},${e}" \
    -depth 8 "public/$out"
  echo "public/$out  ${size}x${size}"
}

icon 32  favicon-32.png
icon 180 apple-touch-icon.png
icon 192 icon-192.png
icon 512 icon-512.png
