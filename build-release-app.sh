#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/dist/Handtyped.app"
BIN="$ROOT/target/release/handtyped_native"
INFO_PLIST="$APP/Contents/Info.plist"
ICON_SRC="$ROOT/icons/icon.png"
ICONSET_DIR="/tmp/handtyped-release.iconset"
ICNS_PATH="$APP/Contents/Resources/Handtyped.icns"

VERSION="$(grep -m1 '^version = ' "$ROOT/Cargo.toml" | sed -E 's/version = "(.*)"/\1/')"
SIGN_IDENTITY="${HANDTYPED_SIGN_IDENTITY:-Developer ID Application: Joseph Tan (JJJL5W8N9N)}"
NOTARY_TMP_DIR=""

cleanup() {
  if [ -n "$NOTARY_TMP_DIR" ] && [ -d "$NOTARY_TMP_DIR" ]; then
    rm -rf "$NOTARY_TMP_DIR"
  fi
}

trap cleanup EXIT

create_notary_archive() {
  local app_path="$1"
  local archive_path="$2"

  echo "Creating notarization archive at $archive_path..."
  ditto -c -k --keepParent "$app_path" "$archive_path"
}

submit_for_notarization() {
  local archive_path="$1"
  local app_path="$2"

  if [ -n "${HANDTYPED_NOTARY_KEYCHAIN_PROFILE:-}" ]; then
    echo "Submitting notarization request with keychain profile: $HANDTYPED_NOTARY_KEYCHAIN_PROFILE"
    xcrun notarytool submit "$archive_path" \
      --keychain-profile "$HANDTYPED_NOTARY_KEYCHAIN_PROFILE" \
      --wait
  elif [ -n "${HANDTYPED_NOTARY_APPLE_ID:-}" ] && \
       [ -n "${HANDTYPED_NOTARY_TEAM_ID:-}" ] && \
       [ -n "${HANDTYPED_NOTARY_PASSWORD:-}" ]; then
    echo "Submitting notarization request with Apple ID: $HANDTYPED_NOTARY_APPLE_ID"
    xcrun notarytool submit "$archive_path" \
      --apple-id "$HANDTYPED_NOTARY_APPLE_ID" \
      --team-id "$HANDTYPED_NOTARY_TEAM_ID" \
      --password "$HANDTYPED_NOTARY_PASSWORD" \
      --wait
  else
    echo "Missing notarization credentials."
    echo "Set HANDTYPED_NOTARY_KEYCHAIN_PROFILE, or HANDTYPED_NOTARY_APPLE_ID + HANDTYPED_NOTARY_TEAM_ID + HANDTYPED_NOTARY_PASSWORD."
    return 1
  fi

  echo "Stapling notarization ticket..."
  xcrun stapler staple "$app_path"

  echo "Validating stapled notarization..."
  xcrun stapler validate "$app_path"
}

main() {
  echo "Building release native Rust editor..."
  cargo build --manifest-path "$ROOT/Cargo.toml" --bin handtyped_native --release

  if [ ! -f "$BIN" ]; then
    echo "Expected release binary not found at $BIN"
    exit 1
  fi

  echo "Assembling release app bundle at $APP..."
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
  ICON_PLIST_KEYS=""
  if iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH"; then
    ICON_PLIST_KEYS='
  <key>CFBundleIconFile</key><string>Handtyped.icns</string>
  <key>CFBundleIconName</key><string>Handtyped</string>'
  else
    echo "Warning: iconutil failed; continuing without a custom .icns file."
    rm -f "$ICNS_PATH"
  fi

  cat > "$INFO_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.handtyped.app</string>
  <key>CFBundleName</key><string>Handtyped</string>
  <key>CFBundleDisplayName</key><string>Handtyped</string>
  <key>CFBundleExecutable</key><string>Handtyped</string>
${ICON_PLIST_KEYS}
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSInputMonitoringUsageDescription</key>
  <string>Handtyped requires Input Monitoring to securely attest that text was typed by a human.</string>
</dict>
</plist>
PLIST

  echo "Signing release app bundle with identity: $SIGN_IDENTITY"
  codesign --force --deep --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"

  echo "Verifying app bundle signature..."
  codesign --verify --deep --strict --verbose=2 "$APP"

  NOTARY_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/handtyped-notary.XXXXXX")"
  local notary_archive="$NOTARY_TMP_DIR/Handtyped.zip"
  create_notary_archive "$APP" "$notary_archive"
  submit_for_notarization "$notary_archive" "$APP"

  echo "Assessing stapled app for Gatekeeper compatibility..."
  spctl --assess --type execute --verbose=4 "$APP"

  echo
  echo "Built release app:"
  echo "  $APP"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
