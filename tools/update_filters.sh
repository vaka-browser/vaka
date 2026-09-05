#!/bin/bash
# Hämtar färska filterlistor (Braves "Update lists"-fix, fast för oss).
# Körs i valfritt av de tre webbläsarträden: ./tools/update_filters.sh
# Byter bara ut en fil om nedladdningen ser ut som en riktig filterlista.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)/filters"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Braves standarduppsättning (list_catalog.json i brave/adblock-resources, default_enabled, utan iOS/Android)
declare -A KALLOR=(
  [ubo-filters.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt"
  [ubo-filters-2020.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2020.txt"
  [ubo-filters-2021.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2021.txt"
  [ubo-filters-2022.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2022.txt"
  [ubo-filters-2023.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2023.txt"
  [ubo-filters-2024.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2024.txt"
  [ubo-filters-2025.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2025.txt"
  [ubo-filters-2026.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2026.txt"
  [ubo-filters-general.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-general.txt"
  [ubo-badware.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt"
  [ubo-resource-abuse.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt"
  [ubo-unbreak.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt"
  [ubo-quick-fixes.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt"
  [ubo-ubo-link-shorteners.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/ubo-link-shorteners.txt"
  [easylist.txt]="https://easylist.to/easylist/easylist.txt"
  [urlhaus-malware.txt]="https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-agh-online.txt"
  [brave-unbreak.txt]="https://raw.githubusercontent.com/brave/adblock-lists/master/brave-unbreak.txt"
  [brave-specific.txt]="https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt"
  [brave-social.txt]="https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-social.txt"
  [brave-unbreak-lists.txt]="https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-unbreak.txt"
  [brave-android-specific.txt]="https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-android-specific.txt"
  [brave-sugarcoat.txt]="https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-sugarcoat.txt"
  [easyprivacy.txt]="https://easylist.to/easylist/easyprivacy.txt"
  [ubo-privacy.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt"
  [brave-firstparty.txt]="https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty.txt"
  [brave-firstparty-regional.txt]="https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty-regional.txt"
  [fanboy-cookiemonster_ubo.txt]="https://secure.fanboy.co.nz/fanboy-cookiemonster_ubo.txt"
  [ubo-annoyances-cookies.txt]="https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-cookies.txt"
  [brave-cookie-specific.txt]="https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-cookie-specific.txt"
  [fanboy-mobile-notifications.txt]="https://secure.fanboy.co.nz/fanboy-mobile-notifications.txt"
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
echo "Klart: $ok uppdaterade, $fel misslyckade. (vaka-unbreak.txt och resources-*.json rörs aldrig.)"
