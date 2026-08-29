# Building Vid2Log for Windows — from a clean machine to a working `.exe`

This is the complete, from-scratch path to producing `dist\vid2log-windows-setup.exe`
on a Windows machine that has never had this project (or Flutter, or Python) on it
before. It mirrors exactly what `scripts\build_windows.ps1`, `scripts\installer.iss`,
and `python_sidecar\vid2log_sidecar.spec` do — nothing here is aspirational or
approximate.

**Must run on Windows.** Neither PyInstaller nor `flutter build windows` can
cross-compile from macOS or Linux — there is no workaround short of a real
Windows machine, a VM, or a Windows CI runner.

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Get the project onto the machine](#2-get-the-project-onto-the-machine)
3. [Set up the Python sidecar's virtual environment](#3-set-up-the-python-sidecars-virtual-environment)
4. [Get Flutter's dependencies](#4-get-flutters-dependencies)
5. [Run the build](#5-run-the-build)
6. [Where the output lands](#6-where-the-output-lands)
7. [Verifying the build](#7-verifying-the-build)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Prerequisites

Six one-time installs. Do them in this order — later steps depend on earlier ones.

| # | Install | Get it from | Notes |
|---|---|---|---|
| 1 | **Git** | https://git-scm.com/download/win | Default options are fine. |
| 2 | **Flutter SDK** (stable channel) | `git clone https://github.com/flutter/flutter.git -b stable C:\flutter` | Add `C:\flutter\bin` to your `PATH`. |
| 3 | **Visual Studio 2022** (Community is fine) | https://visualstudio.microsoft.com/downloads/ | In the installer, tick **"Desktop development with C++"**. Not included by default. |
| 4 | **Python 3.11** (not newer) | https://www.python.org/downloads/release/python-3119/ | Tick **"Add python.exe to PATH"** during install. |
| 5 | **Tesseract OCR** (UB-Mannheim build) | https://github.com/UB-Mannheim/tesseract/wiki | Tick **"Add to PATH"** in its installer. |
| 6 | **Inno Setup 6** | https://jrsoftware.org/isdl.php | Optional — without it the build falls back to a portable `.zip`. |

**Why Python 3.11 specifically:** the ML stack (TensorFlow, OpenCV, scikit-learn) has the
most reliable prebuilt wheels on 3.11. Newer interpreters have been seen pulling
unbuildable package versions when no prebuilt wheel exists for that exact version.

**Why the C++ workload matters twice over:** it's required both for
`flutter build windows` itself, and for compiling any Python package (e.g. `hdbscan`)
that doesn't ship a prebuilt wheel for your exact Python/platform combination.

Once all six are installed, open a **fresh** terminal (so `PATH` changes take effect) and enable Windows desktop support:

```powershell
flutter config --enable-windows-desktop
flutter doctor -v
```

Resolve anything `flutter doctor` reports in red before moving on.

---

## 2. Get the project onto the machine

Copy the whole `vid2log` repository over — USB drive, network share, or `git clone` — keeping
the folder structure intact.

Everything below assumes your terminal is inside the **Flutter project root**: the folder
containing `pubspec.yaml`, `scripts\`, and `python_sidecar\`. In the source tree this is the
inner `vid2log\vid2log\` folder, not the outer repo root that also contains `frontend\` and
`backend\`.

```powershell
cd vid2log\vid2log
```

---

## 3. Set up the Python sidecar's virtual environment

This is a **one-time setup step** — the build script freezes whatever is installed inside
this exact virtual environment, so it has to exist and be complete before you build.

```powershell
cd python_sidecar
py -3.11 -m venv .venv
.\.venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller
cd ..
```

This pulls in TensorFlow, PyTorch, scikit-learn, OpenCV, and the rest of the ML stack —
expect it to take a while and download several gigabytes. Confirm it succeeded:

```powershell
Test-Path python_sidecar\.venv\Scripts\python.exe
```

This should print `True`. The build script checks the same path and refuses to run if it's missing.

---

## 4. Get Flutter's dependencies

```powershell
flutter pub get
```

---

## 5. Run the build

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows.ps1
```

The script performs four steps in order, stopping with a readable error on the first one that fails:

1. **Freeze the sidecar.** Runs `python_sidecar\.venv\Scripts\python.exe -m PyInstaller vid2log_sidecar.spec --noconfirm` — through the venv's own interpreter specifically, so PyInstaller freezes *that* environment rather than a global Python install missing half the dependencies. `vid2log_sidecar.spec` locates Tesseract on `PATH` (or via `VID2LOG_TESSERACT_DIR`) and bundles both the binary and its `tessdata` language files into the frozen app; it raises immediately with setup instructions if Tesseract can't be found, rather than producing a bundle with broken OCR.
2. **Smoke-test the frozen sidecar.** Launches the just-built `vid2log_sidecar.exe` and polls `http://127.0.0.1:8799/health` for up to 60 seconds. A missing hidden import surfaces here, at build time, as a readable traceback — not later as a vague failure on someone else's machine.
3. **Build the Flutter app.** `flutter build windows --release`.
4. **Stage and package.** Copies the frozen sidecar into `build\windows\x64\runner\Release\vid2log_sidecar\`, next to `Vid2Log.exe` — where `lib\services\sidecar_service.dart` looks for it — then compiles the installer with Inno Setup (`scripts\installer.iss`). If `ISCC.exe` isn't found on `PATH` or in the standard install locations, it falls back to zipping the release folder instead, so you still get something shippable.

Expect several minutes total — the PyInstaller freeze in step 1 is the slow part, dominated by TensorFlow.

---

## 6. Where the output lands

```
dist\vid2log-windows-setup.exe      ← if Inno Setup was found
dist\Vid2Log-windows-portable.zip   ← fallback if it wasn't
```

The installer is **per-user** (`PrivilegesRequired=lowest` in `installer.iss`) — no admin
rights required, installs outside `Program Files`, and offers an optional desktop shortcut.

---

## 7. Verifying the build

Run it on the build machine first, but treat that as a weak signal — it already has Python
and Tesseract installed, which can mask a bundling gap. The real test is a **second** Windows
machine that has never had this project, Python, or Tesseract on it:

1. Install and launch. The sidebar status should progress *Starting… → Running offline*
   within roughly 10–30 seconds (TensorFlow's import is the slow part).
2. Process a short video — confirm a scene log comes back.
3. Train a quick two-action model — this exercises TensorFlow, scikit-learn, and the
   native file-picker dialogs from inside the frozen bundle.
4. Check that a resulting log's `source` column shows `fusion` somewhere, not only `cnn` —
   that confirms the bundled Tesseract is actually being *found* at runtime, not just
   present somewhere in the install folder.

---

## 8. Troubleshooting

**`ModuleNotFoundError` for something clearly installed**
PyInstaller was run outside the virtual environment — a globally installed `pyinstaller`
freezes whatever's on the *global* Python, missing everything in `.venv`. The build script
already invokes `.venv\Scripts\python.exe -m PyInstaller` for exactly this reason; don't run
a bare `pyinstaller` command by hand.

**`tesseract not found on PATH`**
Either it wasn't added to `PATH` during install, or your terminal was open before installing
it (`PATH` changes need a fresh terminal). Workaround without reinstalling:
```powershell
$env:VID2LOG_TESSERACT_DIR = "C:\Program Files\Tesseract-OCR"
```

**The sidecar smoke test never goes healthy**
Almost always a missing hidden import for something imported lazily inside a function.
Add it to `hiddenimports` in `python_sidecar\vid2log_sidecar.spec` and rebuild.

**"Inno Setup not found — producing a portable .zip instead"**
Confirm `ISCC.exe` exists at `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`. If installed
somewhere else, add that folder to `PATH`.

**Antivirus flags the frozen `.exe` or the installer**
A common false positive for PyInstaller-frozen binaries. Whitelist the `dist\` and
`python_sidecar\dist\` folders while iterating on builds if this interferes.

**"Windows protected your PC" (SmartScreen) on first run**
Expected for an unsigned installer — click *More info → Run anyway*. Removing this warning
requires a paid code-signing certificate; it's cosmetic, not a build defect.

---

*See `RELEASE.md` at the project root for the equivalent macOS `.dmg` build process, and for
background on why the app is packaged the way it is (one-dir vs one-file, bundled Tesseract,
user data location).*
