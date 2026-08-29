# Packaging vid2log for release

How to turn this repo into a `.dmg` you can hand someone on a Mac, or a
`.exe` installer for Windows.

## What "packaging" actually involves here

The app is a Flutter shell plus a Python sidecar that does all the real
work (TensorFlow, OpenCV, scikit-learn, Tesseract OCR). In development the
Flutter app spawns `python_sidecar/.venv/bin/python3` — which only exists
on your machine. A release build has to ship a **frozen** copy of that
sidecar instead, so the end user needs no Python, no pip, and no
virtualenv.

So each build is four steps, and the scripts do all of them:

1. **Freeze the sidecar** with PyInstaller into a standalone executable
   (`python_sidecar/vid2log_sidecar.spec`), with the default model and
   Tesseract bundled inside it.
2. **Build the Flutter app** (`flutter build macos` / `windows`).
3. **Copy the frozen sidecar into the app** — `Contents/Resources/` on
   macOS, beside the `.exe` on Windows. `lib/services/sidecar_service.dart`
   looks in both places, preferring the bundled copy over any `.venv`.
4. **Package** as a `.dmg` or an Inno Setup installer.

**You cannot cross-compile.** A macOS build must be made on macOS and a
Windows build on Windows — this is true of both PyInstaller and Flutter's
desktop builds. If you don't have a Windows machine, use a VM or a CI
runner (GitHub Actions provides `windows-latest`).

Expect **1.5–2.5 GB** installed, dominated by TensorFlow. That's inherent
to shipping a local ML runtime; the alternative is asking users to install
Python and a 2 GB dependency tree themselves.

---

## App icon (do this once, before your first release build)

Flutter ships a placeholder icon. To use the vid2log logo instead:

```bash
cd vid2log
python_sidecar/.venv/bin/python3 scripts/make_app_icon.py ../frontend/public/icon-512.png
flutter pub get
dart run flutter_launcher_icons
```

`make_app_icon.py` centres the logo on a transparent 1024×1024 canvas at
80% scale. That padding is not cosmetic fussiness — macOS icons are drawn
on a 1024 canvas with the artwork occupying roughly 80% of it, so a logo
that fills its canvas edge-to-edge renders visibly **larger** than every
other app in the Dock and Launchpad. Adjust `SCALE` in that script if it
still looks off next to its neighbours.

`icon-512.png` is used rather than `assets/vid2log-logo.png` because macOS
downscales from the 1024 master; upscaling the small sidebar logo would
look soft. If you have the logo at higher resolution, pass that instead.

`dart run flutter_launcher_icons` then regenerates
`macos/Runner/Assets.xcassets/AppIcon.appiconset/` and the Windows `.ico`.
Commit the generated files — they're build inputs, not build output.

**If the Dock still shows the old icon**, that's macOS's icon cache, not a
build problem — Finder and the Dock cache separately, so Finder can show
the new icon while the Dock shows the old one. Force a refresh:

```bash
touch /Applications/Vid2Log.app
killall Dock
```

If it persists, `sudo rm -rf /Library/Caches/com.apple.iconservices.store`
then `killall Dock` clears it system-wide.

---

## macOS → `.dmg`

### One-time setup

```bash
brew install tesseract create-dmg
cd vid2log/python_sidecar
python3.11 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

Tesseract has to be installed **at build time** because the build copies it
into the app. Users won't need it.

### Build

```bash
cd vid2log
./scripts/build_macos.sh
```

Output: `dist/Vid2Log-macos.dmg`.

The script smoke-tests the frozen sidecar (starts it, waits for
`/health`) before packaging, so a missing dependency shows up as a readable
traceback at build time rather than as "Local engine failed to start" on
someone else's Mac.

### Signing and notarization

Without this, other Macs refuse to open the app — Gatekeeper reports it as
*"damaged and can't be opened"*, which is misleading; it just means
unsigned. The `.dmg` still works on the machine that built it, which is
enough for testing but not for distribution.

Doing it properly needs a paid Apple Developer account ($99/yr):

```bash
# Sign as part of the build
export VID2LOG_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
./scripts/build_macos.sh

# Then notarize the .dmg and staple the ticket
xcrun notarytool submit dist/Vid2Log-macos.dmg \
  --apple-id "you@example.com" --team-id "TEAMID" \
  --password "app-specific-password" --wait
xcrun stapler staple dist/Vid2Log-macos.dmg
```

Signing happens *after* the sidecar is copied in — copying unsigned
binaries into a signed bundle invalidates the signature, so the order
matters.

**Without a developer account**, a recipient can still open it:
right-click the app → Open → Open, or
`xattr -dr com.apple.quarantine /Applications/Vid2Log.app`. Fine for a
handful of colleagues; not something to ask the public to do.

---

## Windows → `.exe`

### One-time setup

- Install Tesseract from the
  [UB-Mannheim build](https://github.com/UB-Mannheim/tesseract/wiki) and
  tick "Add to PATH", or set `VID2LOG_TESSERACT_DIR` to its install folder.
- Install [Inno Setup 6](https://jrsoftware.org/isdl.php).
- Install Visual Studio with the "Desktop development with C++" workload
  (Flutter's Windows builds need it).

```powershell
cd vid2log\python_sidecar
py -3.11 -m venv .venv
.\.venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
```

### Build

```powershell
cd vid2log
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows.ps1
```

Output: `dist\vid2log-windows-setup.exe`. If Inno Setup isn't installed the
script falls back to producing a portable `.zip` instead, so you still get
something shippable.

### SmartScreen

Unsigned installers trigger "Windows protected your PC" on first run
(users click *More info → Run anyway*). Removing that needs a code-signing
certificate from a CA — roughly $200–400/yr, and an EV certificate to clear
the warning immediately rather than after building reputation. Usually not
worth it for internal or research distribution.

---

## Verifying a build

On a machine that has **never** had this project set up:

1. Install and launch. The sidebar's status row should go
   *Starting… → Running offline* within ~10–30 s (TensorFlow's first import
   is the slow part).
2. Process a short video. A scene log should come back.
3. Train a two-action model — confirms TensorFlow, scikit-learn and the
   file dialogs all work from the bundle.
4. Check a log's `source` column shows `fusion` somewhere, which confirms
   the **bundled Tesseract** is being found. If every row says `cnn`, OCR
   silently isn't running.

Testing on your own dev machine proves less than it seems: it has Python,
Tesseract and the venv already, so a bundle missing any of them can still
appear to work.

---

## Troubleshooting

**"Local engine failed to start: Sidecar exited (code N)"**
The error banner shows the sidecar's own last line, and the full output is
always written to `~/.vid2log/sidecar.log`. Read that first:

```bash
cat ~/.vid2log/sidecar.log
```

A GUI app launched from Finder has no terminal, so that file is the only
record — which is why it exists. To reproduce interactively, run the
frozen binary yourself and watch it live:

```bash
/Applications/Vid2Log.app/Contents/Resources/vid2log_sidecar/vid2log_sidecar --port 8799
```

Almost always a missing hidden import — add it to `hiddenimports` in
`vid2log_sidecar.spec` and rebuild.

**"Address already in use" / exit code 3 right after launch**
Another sidecar is already on port 8756 — usually one left behind by a
`flutter run` session or an earlier launch. The app now adopts a healthy
sidecar it finds there instead of spawning a duplicate, so this should be
self-correcting; if a *stale* one is wedged, kill it:

```bash
lsof -ti :8756 | xargs kill
```

Note that uvicorn prints its normal shutdown messages after a failed
startup, so the last line of the log ("Application shutdown complete") is
not the error — look a few lines above it.

**`ModuleNotFoundError` for something that's clearly installed**
PyInstaller freezes the environment it's *run from*. The build scripts
invoke `.venv/bin/python -m PyInstaller` for exactly this reason; running a
globally-installed `pyinstaller` instead produces a bundle missing
everything in the venv.

**OCR does nothing / every scene's source is `cnn`**
The bundled Tesseract isn't being found. Confirm
`vid2log_sidecar/tesseract/` exists in the built app and contains both the
binary and a `tessdata/` folder with `*.traineddata` files. `app/bundle.py`
sets `TESSDATA_PREFIX` to point at it; without that Tesseract fails with
"Error opening data file" even though the binary launches fine.

**The app is enormous**
Mostly TensorFlow. `vid2log_sidecar.spec` already excludes matplotlib,
IPython, Jupyter and tkinter. Going meaningfully smaller means moving
inference to ONNX Runtime and dropping TensorFlow — a real project, not a
packaging tweak.

**macOS: "damaged and can't be opened"**
Not damaged, unsigned. See *Signing and notarization* above.

---

## User data

The database, trained models and action datasets live in `~/.vid2log/`,
outside the app bundle. That's deliberate:

- app bundles are read-only for normal users in `/Applications` and
  `Program Files`;
- an app update replaces the bundle, and burying user data inside it would
  destroy every trained model on upgrade.

Uninstalling leaves `~/.vid2log/` in place. Deleting someone's trained
models because they reinstalled a newer version isn't a defensible default;
they can remove the folder themselves.
