#!/bin/bash
set -e

pkill -f "HumanProof" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 1

echo "Building Swift..."
swift build 2>&1

APP="$HOME/Applications/HumanProof.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp .build/debug/HumanProof "$APP/Contents/MacOS/HumanProof"

cat > "$APP/Contents/Info.plist" << 'PLIST'
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

codesign --force --deep --sign "HumanProof Dev" "$APP" 2>/dev/null || \
  codesign --force --deep --sign - "$APP" 2>/dev/null

npm run dev &
VITE_PID=$!
sleep 3

echo "Launching HumanProof..."
open "$APP"
echo "Running. Stop with: pkill HumanProof && pkill -f vite"
wait $VITE_PID
