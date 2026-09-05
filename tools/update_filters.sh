#!/bin/bash
# Hämtar färska filterlistor (Braves "Update lists"-fix, fast för oss).
# Körs i valfritt av de tre webbläsarträden: ./tools/update_filters.sh
# Byter bara ut en fil om nedladdningen ser ut som en riktig filterlista.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)/filters"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

declare -A KALLOR=(
  [easylist.txt]="https://easylist.to/easylist/easylist.txt"
  [easyprivacy.txt]="https://easylist.to/easylist/easyprivacy.txt"
  [fanboy-annoyance.txt]="https://secure.fanboy.co.nz/fanboy-annoyance.txt"
  [adguard-base.txt]="https://filters.adtidy.org/extension/ublock/filters/2.txt"
  [peter-lowe.txt]="https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&mimetype=plaintext"
  [ublock-filters.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt"
  [ublock-badware.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt"
  [ublock-privacy.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt"
  [ublock-resource-abuse.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt"
  [ublock-unbreak.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt"
  [ublock-quick-fixes.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt"
)

ok=0; fel=0
for fil in "${!KALLOR[@]}"; do
  url="${KALLOR[$fil]}"
  if curl -sfL --max-time 60 -o "$TMP/$fil" "$url" \
     && [ -s "$TMP/$fil" ] \
     && head -c 200 "$TMP/$fil" | grep -qE '^(\[Adblock|!)'; then
    mv "$TMP/$fil" "$DIR/$fil"
    echo "✓ $fil ($(wc -c < "$DIR/$fil" | numfmt --to=iec))"
    ok=$((ok+1))
  else
    echo "✗ $fil — behåller gamla ($url)" >&2
    fel=$((fel+1))
  fi
done
echo "Klart: $ok uppdaterade, $fel misslyckade. (vaka-unbreak.txt och resources.txt rörs aldrig.)"
