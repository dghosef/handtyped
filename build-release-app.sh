#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
RELEASE_TARGET="${HANDTYPED_RELEASE_TARGET:-}"
if [ -n "$RELEASE_TARGET" ] && [ -z "${HANDTYPED_RELEASE_UNIVERSAL+x}" ]; then
  RELEASE_UNIVERSAL=0
else
  RELEASE_UNIVERSAL="${HANDTYPED_RELEASE_UNIVERSAL:-1}"
fi
case "$RELEASE_UNIVERSAL" in
  1|true|yes) RELEASE_UNIVERSAL=1 ;;
  0|false|no) RELEASE_UNIVERSAL=0 ;;
  *)
    echo "HANDTYPED_RELEASE_UNIVERSAL must be 1/true/yes or 0/false/no"
    exit 1
    ;;
esac
if [ "$RELEASE_UNIVERSAL" = "1" ] && [ -n "$RELEASE_TARGET" ]; then
  echo "HANDTYPED_RELEASE_TARGET cannot be combined with HANDTYPED_RELEASE_UNIVERSAL=1"
  exit 1
fi
APP="$ROOT/dist/Handtyped.app"
INFO_PLIST="$APP/Contents/Info.plist"
ICON_SRC="$ROOT/icons/icon.png"
ICONSET_DIR="/tmp/handtyped-release.iconset"
ICNS_PATH="$APP/Contents/Resources/Handtyped.icns"
PUBLIC_DOWNLOADS_DIR="${PUBLIC_DOWNLOADS_DIR:-$ROOT/replay-server/public/downloads}"

VERSION="$(grep -m1 '^version = ' "$ROOT/Cargo.toml" | sed -E 's/version = "(.*)"/\1/')"
MACOS_MIN_VERSION_INTEL="${HANDTYPED_MACOS_MIN_VERSION_INTEL:-10.13}"
MACOS_MIN_VERSION_APPLE_SILICON="${HANDTYPED_MACOS_MIN_VERSION_APPLE_SILICON:-11.0}"
SIGN_IDENTITY="${HANDTYPED_SIGN_IDENTITY:-Developer ID Application: Joseph Tan (JJJL5W8N9N)}"
NOTARY_TMP_DIR=""

release_target_arch() {
  local target="${1:-$RELEASE_TARGET}"
  if [ -n "$target" ]; then
    case "$target" in
      aarch64-apple-darwin) echo "arm64" ;;
      x86_64-apple-darwin) echo "x86_64" ;;
      *) echo "$target" ;;
    esac
  else
    uname -m
  fi
}

release_macos_min_version() {
  local target="${1:-$RELEASE_TARGET}"
  case "$(release_target_arch "$target")" in
    arm64|aarch64) echo "$MACOS_MIN_VERSION_APPLE_SILICON" ;;
    *) echo "$MACOS_MIN_VERSION_INTEL" ;;
  esac
}

if [ "$RELEASE_UNIVERSAL" = "1" ]; then
  MACOS_MIN_VERSION="${HANDTYPED_MACOS_MIN_VERSION:-$MACOS_MIN_VERSION_INTEL}"
else
  MACOS_MIN_VERSION="${HANDTYPED_MACOS_MIN_VERSION:-$(release_macos_min_version "$RELEASE_TARGET")}"
fi

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

create_release_zip() {
  local app_path="$1"
  local zip_path="$2"

  echo "Creating release zip at $zip_path..."
  ditto -c -k --keepParent "$app_path" "$zip_path"
}

create_release_dmg() {
  local app_path="$1"
  local dmg_path="$2"

  echo "Creating release DMG at $dmg_path..."
  hdiutil create \
    -quiet \
    -format UDZO \
    -volname "Handtyped" \
    -srcfolder "$app_path" \
    "$dmg_path"
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

publish_release_artifacts() {
  local app_path="$1"
  local dmg_path="$2"
  local zip_path="$3"

  echo "Publishing release artifacts to $PUBLIC_DOWNLOADS_DIR..."
  mkdir -p "$PUBLIC_DOWNLOADS_DIR"
  cp "$dmg_path" "$PUBLIC_DOWNLOADS_DIR/Handtyped-macos.dmg"
  cp "$zip_path" "$PUBLIC_DOWNLOADS_DIR/Handtyped-macos.zip"
}

bin_for_target() {
  local target="$1"
  if [ -n "$target" ]; then
    echo "$ROOT/target/$target/release/handtyped_native"
  else
    echo "$ROOT/target/release/handtyped_native"
  fi
}

build_release_binary() {
  local target="$1"
  local min_version="$2"
  local label="${target:-host}"

  echo "Building release native Rust editor for $label..."
  echo "Using macOS deployment target for $label: $min_version"
  if [ -n "$target" ]; then
    (cd "$ROOT" && MACOSX_DEPLOYMENT_TARGET="$min_version" cargo build --bin handtyped_native --release --target "$target")
  else
    (cd "$ROOT" && MACOSX_DEPLOYMENT_TARGET="$min_version" cargo build --bin handtyped_native --release)
  fi

  local bin
  bin="$(bin_for_target "$target")"
  if [ ! -f "$bin" ]; then
    echo "Expected release binary not found at $bin"
    exit 1
  fi
}

prepare_release_app_bundle_metadata() {
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
  <key>LSMinimumSystemVersion</key><string>${MACOS_MIN_VERSION}</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSInputMonitoringUsageDescription</key>
  <string>Handtyped requires Input Monitoring to securely attest that text was typed by a human.</string>
</dict>
</plist>
PLIST
}

assemble_release_app_from_binary() {
  local bin="$1"

  echo "Assembling release app bundle at $APP..."
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS"
  mkdir -p "$APP/Contents/Resources"
  cp "$bin" "$APP/Contents/MacOS/Handtyped"
  chmod +x "$APP/Contents/MacOS/Handtyped"
  prepare_release_app_bundle_metadata
}

assemble_release_app_universal() {
  local arm_bin
  local intel_bin
  arm_bin="$(bin_for_target "aarch64-apple-darwin")"
  intel_bin="$(bin_for_target "x86_64-apple-darwin")"

  echo "Assembling universal release app bundle at $APP..."
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS"
  mkdir -p "$APP/Contents/Resources"
  lipo -create "$arm_bin" "$intel_bin" -output "$APP/Contents/MacOS/Handtyped"
  chmod +x "$APP/Contents/MacOS/Handtyped"
  lipo -info "$APP/Contents/MacOS/Handtyped"
  prepare_release_app_bundle_metadata
}

main() {
  if [ "$RELEASE_UNIVERSAL" = "1" ]; then
    echo "Building universal release native Rust editor..."
    build_release_binary "aarch64-apple-darwin" "$MACOS_MIN_VERSION_APPLE_SILICON"
    build_release_binary "x86_64-apple-darwin" "$MACOS_MIN_VERSION_INTEL"
    assemble_release_app_universal
  else
    build_release_binary "$RELEASE_TARGET" "$MACOS_MIN_VERSION"
    assemble_release_app_from_binary "$(bin_for_target "$RELEASE_TARGET")"
  fi

  echo "Signing release app bundle with identity: $SIGN_IDENTITY"
  codesign --force --deep --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"

  echo "Verifying app bundle signature..."
  codesign --verify --deep --strict --verbose=2 "$APP"

  NOTARY_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/handtyped-notary.XXXXXX")"
  local notary_archive="$NOTARY_TMP_DIR/Handtyped.zip"
  local release_zip="$NOTARY_TMP_DIR/Handtyped-macos.zip"
  local release_dmg="$NOTARY_TMP_DIR/Handtyped-macos.dmg"
  create_notary_archive "$APP" "$notary_archive"
  submit_for_notarization "$notary_archive" "$APP"
  create_release_dmg "$APP" "$release_dmg"
  create_release_zip "$APP" "$release_zip"
  publish_release_artifacts "$APP" "$release_dmg" "$release_zip"

  echo "Assessing stapled app for Gatekeeper compatibility..."
  spctl --assess --type execute --verbose=4 "$APP"

  echo
  echo "Built release app:"
  echo "  $APP"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
