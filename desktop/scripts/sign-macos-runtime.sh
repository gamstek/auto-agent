#!/usr/bin/env bash
set -euo pipefail

: "${APPLE_SIGNING_IDENTITY:?Missing macOS signing identity}"
root=${1:?Missing runtime directory}
find "$root" -type f \( -name '*.node' -o -name '*.dylib' -o -perm -100 \) -print0 |
while IFS= read -r -d '' file; do
  format=$(/usr/bin/file -b "$file")
  if [[ $format == *Mach-O* ]]; then
    /usr/bin/codesign --force --timestamp --options runtime --sign "$APPLE_SIGNING_IDENTITY" "$file"
  fi
done
