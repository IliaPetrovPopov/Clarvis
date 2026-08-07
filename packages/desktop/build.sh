#!/bin/bash
# Build Clarvis.app.
#
# A native window around the dashboard, using the system webview. Nothing is
# bundled but the binary and the icon, so the whole thing is about a megabyte
# where Electron would have been two hundred for a rendering engine already
# installed on the machine.
#
#   ./build.sh              build into packages/desktop/build
#   ./build.sh /Applications   build and install
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEST="${1:-$HERE/build}"
APP="$DEST/Clarvis.app"

# The dashboard has to exist before it can be wrapped.
if [ ! -f "$ROOT/packages/ui/dist/index.html" ]; then
  echo "  building the dashboard first"
  (cd "$ROOT" && pnpm --filter @clarvis/ui build >/dev/null)
fi

# An app launched from the dock inherits almost no PATH, so the interpreter is
# resolved here and baked into the bundle. Guessing at runtime is how a
# nvm-managed node ends up unfindable and the window opens onto nothing.
NODE_PATH_RESOLVED="$(command -v node)"
CLI_PATH="$ROOT/packages/cli/bin/clarvis.mjs"

if [ ! -x "$NODE_PATH_RESOLVED" ]; then
  echo "  node not found on PATH; cannot bake an interpreter into the app" >&2
  exit 1
fi
if [ ! -f "$CLI_PATH" ]; then
  echo "  clarvis CLI not found at $CLI_PATH" >&2
  exit 1
fi

echo "  node     $NODE_PATH_RESOLVED"
echo "  cli      $CLI_PATH"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# --- icon -------------------------------------------------------------------
# Drawn at build time rather than committed: a binary asset is a thing nobody
# can review and everybody is afraid to change.
ICONSET="$(mktemp -d)/Clarvis.iconset"
swiftc -O -o "$HERE/.makeicon" "$HERE/MakeIcon.swift" \
  -framework AppKit -framework CoreGraphics -framework ImageIO 2>/dev/null
"$HERE/.makeicon" "$ICONSET" >/dev/null
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Clarvis.icns"
rm -f "$HERE/.makeicon"

# --- binary -----------------------------------------------------------------
swiftc -O -o "$APP/Contents/MacOS/Clarvis" "$HERE/Clarvis.swift" \
  -framework AppKit -framework WebKit

# --- bundle -----------------------------------------------------------------
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Clarvis</string>
  <key>CFBundleDisplayName</key><string>Clarvis</string>
  <key>CFBundleIdentifier</key><string>dev.clarvis.desktop</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Clarvis</string>
  <key>CFBundleIconFile</key><string>Clarvis</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- The window is very dark; without this the title bar is light on launch. -->
  <key>NSRequiresAquaSystemAppearance</key><false/>
  <!-- Baked, because a Finder launch has no useful PATH. -->
  <key>ClarvisNodePath</key><string>$NODE_PATH_RESOLVED</string>
  <key>ClarvisCliPath</key><string>$CLI_PATH</string>
  <!-- It talks to 127.0.0.1 over http, which ATS blocks by default. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

# Ad-hoc signature. Enough for a personal build; without it macOS refuses to
# launch an unsigned binary on Apple silicon.
codesign --force --deep --sign - "$APP" 2>/dev/null || {
  echo "  codesign failed - the app may not launch" >&2
}

echo "  built    $APP"
if [ "$DEST" = "/Applications" ]; then
  echo "  installed. It is in Applications and in Spotlight."
else
  echo "  run it:  open '$APP'"
  echo "  install: $0 /Applications"
fi
