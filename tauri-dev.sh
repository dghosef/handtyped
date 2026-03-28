#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/HumanProof.app"
BIN="$ROOT/src-tauri/target/debug/humanproof"
INFO_PLIST="$APP/Contents/Info.plist"

pkill -f "HumanProof.app" 2>/dev/null || true
pkill -f "/HumanProof$" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 1

echo "Starting Vite dev server..."
(cd "$ROOT" && npm run dev) &
VITE_PID=$!
trap 'kill $VITE_PID 2>/dev/null || true' EXIT

sleep 3

echo "Building Tauri debug binary..."
cargo build --manifest-path "$ROOT/src-tauri/Cargo.toml" --no-default-features

if [ ! -f "$BIN" ]; then
  echo "Expected binary not found at $BIN"
  exit 1
fi

echo "Assembling app bundle at $APP..."
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/HumanProof"

cat > "$INFO_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.humanproof.app</string>
  <key>CFBundleName</key><string>HumanProof</string>
  <key>CFBundleDisplayName</key><string>HumanProof</string>
  <key>CFBundleExecutable</key><string>HumanProof</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSInputMonitoringUsageDescription</key>
  <string>HumanProof requires Input Monitoring to securely attest that text was typed by a human.</string>
</dict>
</plist>
PLIST

echo "Signing app bundle..."
codesign --force --deep --sign "HumanProof Dev" "$APP" 2>/dev/null || \
  codesign --force --deep --sign - "$APP" 2>/dev/null

echo "Launching HumanProof..."
open "$APP"
echo "HumanProof is running from a signed app bundle."
echo "If Input Monitoring was previously granted to an older dev binary, remove old entries in Privacy & Security > Input Monitoring and grant it to this app bundle once."

wait $VITE_PID
