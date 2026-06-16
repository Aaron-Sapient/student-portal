#!/bin/bash
# Builds scripts/student-portal-icon.svg into an .icns and installs it on
# "/Applications/Student Portal.app". Re-run after any `osacompile` rebuild
# of the app (recompiling resets the bundle to the stock applet icon).
set -euo pipefail

SVG="$(dirname "$0")/student-portal-icon.svg"
APP="/Applications/Student Portal.app"
WORK="$(mktemp -d)"
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"

sips -s format png "$SVG" --out "$WORK/1024.png" >/dev/null

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$WORK/1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  retina=$((size * 2))
  sips -z "$retina" "$retina" "$WORK/1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o "$WORK/AppIcon.icns"

cp "$WORK/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
# Assets.car ships a compiled stock icon that overrides any .icns when
# CFBundleIconName is set — both must go or the custom icon never shows.
rm -f "$APP/Contents/Resources/Assets.car"
plutil -remove CFBundleIconName "$APP/Contents/Info.plist" 2>/dev/null || true
plutil -replace CFBundleIconFile -string "AppIcon" "$APP/Contents/Info.plist"

# Modifying the bundle invalidates its signature; re-sign ad-hoc.
codesign --force -s - "$APP"

# Bust the Finder/Dock icon caches.
touch "$APP"
rm -rf "$WORK"
echo "Icon installed. If Finder/Dock still shows the old icon: killall Finder Dock"
