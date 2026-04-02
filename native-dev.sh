#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/Handtyped.app"
BIN="$ROOT/target/debug/handtyped_native"
INFO_PLIST="$APP/Contents/Info.plist"
# To change the app icon: replace icons/icon.png with a square PNG (1024x1024
# recommended). The image is also embedded in the binary via include_bytes! in
# src/bin/handtyped_native.rs (the `icon_data` line), so just replacing the
# file and re-running this script is all you need.
ICON_SRC="$ROOT/icons/icon.png"
ICONSET_DIR="/tmp/handtyped.iconset"
ICNS_PATH="$APP/Contents/Resources/Handtyped.icns"

pkill -f "Handtyped.app" 2>/dev/null || true
pkill -f "/Handtyped$" 2>/dev/null || true
pkill -f "/handtyped_native$" 2>/dev/null || true
sleep 1

echo "Building native Rust editor..."
cargo build --manifest-path "$ROOT/Cargo.toml" --bin handtyped_native

if [ ! -f "$BIN" ]; then
  echo "Expected binary not found at $BIN"
  exit 1
fi

echo "Assembling native app bundle at $APP..."
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Handtyped"
cp "$ROOT/assets/handtyped-logo.svg" "$APP/Contents/Resources/handtyped-logo.svg"

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"
sips -z 16 16 "$ICON_SRC" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$ICON_SRC" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$ICON_SRC" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$ICON_SRC" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$ICON_SRC" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$ICON_SRC" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$ICON_SRC" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$ICON_SRC" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$ICON_SRC" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
cp "$ICON_SRC" "$ICONSET_DIR/icon_512x512@2x.png"
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH"

cat > "$INFO_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.handtyped.app</string>
  <key>CFBundleName</key><string>Handtyped</string>
  <key>CFBundleDisplayName</key><string>Handtyped</string>
  <key>CFBundleExecutable</key><string>Handtyped</string>
  <key>CFBundleIconFile</key><string>Handtyped.icns</string>
  <key>CFBundleIconName</key><string>Handtyped</string>
  <key>CFBundleIcons</key>
  <dict>
    <key>CFBundlePrimaryIcon</key>
    <dict>
      <key>CFBundleIconFile</key><string>Handtyped.icns</string>
      <key>CFBundleIconName</key><string>Handtyped</string>
    </dict>
  </dict>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSInputMonitoringUsageDescription</key>
  <string>Handtyped requires Input Monitoring to securely attest that text was typed by a human.</string>
</dict>
</plist>
PLIST

echo "Signing native app bundle..."
codesign --force --deep --sign "Handtyped Dev" "$APP" 2>/dev/null || \
  codesign --force --deep --sign - "$APP" 2>/dev/null

echo "Launching Handtyped..."
open "$APP"
echo "Handtyped native editor is running from a signed app bundle."
echo "If Input Monitoring is still tied to an older binary, remove old entries in Privacy & Security > Input Monitoring and grant it to this app bundle once."
