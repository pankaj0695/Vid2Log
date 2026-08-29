#!/usr/bin/env bash
#
# Builds a distributable macOS .dmg.
#
#   ./scripts/build_macos.sh
#
# Steps: freeze the Python sidecar -> build the Flutter app -> copy the
# sidecar into the .app -> package as a .dmg.
#
# Must run on macOS. Neither PyInstaller nor `flutter build macos` can
# cross-compile from another platform.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_DIR="$PROJECT_ROOT/python_sidecar"
VENV_PYTHON="$SIDECAR_DIR/.venv/bin/python3"
# Must match PRODUCT_NAME in macos/Runner/Configs/AppInfo.xcconfig — that's
# what determines the built bundle's name.
APP_NAME="Vid2Log"
DIST_DIR="$PROJECT_ROOT/dist"

echo "==> Project: $PROJECT_ROOT"

# ── Preflight ─────────────────────────────────────────────────────────────
if [[ ! -x "$VENV_PYTHON" ]]; then
  echo "ERROR: $VENV_PYTHON not found." >&2
  echo "Set up the sidecar venv first — see python_sidecar/README.md." >&2
  exit 1
fi

if ! command -v tesseract >/dev/null 2>&1 && [[ -z "${VID2LOG_TESSERACT_DIR:-}" ]]; then
  echo "ERROR: tesseract not found on PATH." >&2
  echo "It gets bundled into the app, so it must exist at build time:" >&2
  echo "  brew install tesseract" >&2
  exit 1
fi

# ── 1. Freeze the sidecar ─────────────────────────────────────────────────
# Run through the venv's own python so PyInstaller freezes THAT environment.
# Invoking a globally-installed `pyinstaller` here would silently produce a
# bundle missing TensorFlow and everything else installed in the venv.
echo "==> Freezing the Python sidecar (this takes a few minutes)…"
cd "$SIDECAR_DIR"
rm -rf build dist
"$VENV_PYTHON" -m PyInstaller vid2log_sidecar.spec --noconfirm

SIDECAR_BUILD="$SIDECAR_DIR/dist/vid2log_sidecar"
if [[ ! -x "$SIDECAR_BUILD/vid2log_sidecar" ]]; then
  echo "ERROR: expected $SIDECAR_BUILD/vid2log_sidecar after freezing." >&2
  exit 1
fi

# Smoke-test the frozen binary before it goes anywhere near the .app — a
# missing hidden import shows up here as a clear traceback, rather than as
# "Local engine failed to start" once someone installs the .dmg.
echo "==> Smoke-testing the frozen sidecar…"
"$SIDECAR_BUILD/vid2log_sidecar" --port 8799 &
SIDECAR_PID=$!
trap 'kill $SIDECAR_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:8799/health" >/dev/null 2>&1; then
    echo "    sidecar responded OK"
    break
  fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:8799/health" >/dev/null 2>&1; then
  echo "ERROR: the frozen sidecar never became healthy. Its output above" >&2
  echo "should say why — usually a missing hidden import in the spec." >&2
  exit 1
fi
kill $SIDECAR_PID 2>/dev/null || true
trap - EXIT

# ── 2. Build the Flutter app ──────────────────────────────────────────────
echo "==> Building the Flutter app…"
cd "$PROJECT_ROOT"
flutter build macos --release

APP_BUNDLE="$PROJECT_ROOT/build/macos/Build/Products/Release/$APP_NAME.app"
if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "ERROR: $APP_BUNDLE not found after the Flutter build." >&2
  exit 1
fi

# ── 3. Copy the sidecar into the bundle ───────────────────────────────────
# Contents/Resources is the conventional home for bundled support files and
# is exactly where lib/services/sidecar_service.dart looks first.
echo "==> Copying the sidecar into the .app…"
RESOURCES="$APP_BUNDLE/Contents/Resources"
rm -rf "$RESOURCES/vid2log_sidecar"
cp -R "$SIDECAR_BUILD" "$RESOURCES/vid2log_sidecar"
chmod +x "$RESOURCES/vid2log_sidecar/vid2log_sidecar"
chmod +x "$RESOURCES/vid2log_sidecar/tesseract" 2>/dev/null || true

# ── 4. Sign (optional) ────────────────────────────────────────────────────
# Copying unsigned binaries into a signed bundle invalidates its signature,
# so any signing has to happen AFTER the copy above, not before.
if [[ -n "${VID2LOG_SIGN_IDENTITY:-}" ]]; then
  echo "==> Code-signing with: $VID2LOG_SIGN_IDENTITY"
  # --deep is deprecated but still the pragmatic way to sign a tree of
  # bundled helper binaries. Hardened runtime is required for notarization;
  # the JIT/unsigned-memory entitlements are what let the Dart VM and
  # TensorFlow run under it.
  codesign --force --deep --options runtime --timestamp \
    --sign "$VID2LOG_SIGN_IDENTITY" "$APP_BUNDLE"
  codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
else
  echo "==> Skipping code signing (VID2LOG_SIGN_IDENTITY not set)."
  echo "    The .dmg will work on THIS machine, but other Macs will refuse"
  echo "    to open it until it's signed and notarized. See RELEASE.md."
fi

# ── 5. Package the .dmg ───────────────────────────────────────────────────
mkdir -p "$DIST_DIR"
DMG_PATH="$DIST_DIR/Vid2Log-macos.dmg"
rm -f "$DMG_PATH"

if command -v create-dmg >/dev/null 2>&1; then
  echo "==> Creating the .dmg…"
  # create-dmg exits non-zero when it can't set a custom icon position,
  # which is cosmetic — the .dmg is still produced, so don't fail on it.
  create-dmg \
    --volname "$APP_NAME" \
    --window-size 600 400 \
    --icon-size 100 \
    --icon "$APP_NAME.app" 150 190 \
    --app-drop-link 450 190 \
    "$DMG_PATH" \
    "$APP_BUNDLE" || true
else
  echo "==> create-dmg not installed; falling back to hdiutil."
  echo "    (brew install create-dmg gives a nicer drag-to-Applications window.)"
  STAGING="$(mktemp -d)"
  cp -R "$APP_BUNDLE" "$STAGING/"
  ln -s /Applications "$STAGING/Applications"
  hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING" -ov -format UDZO "$DMG_PATH"
  rm -rf "$STAGING"
fi

echo
echo "Done: $DMG_PATH"
du -sh "$DMG_PATH"
