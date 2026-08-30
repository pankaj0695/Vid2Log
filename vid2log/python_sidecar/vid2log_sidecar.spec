# PyInstaller spec that freezes the sidecar into a standalone executable, so
# a packaged .app/.exe doesn't need Python, pip, or a virtualenv on the
# end user's machine.
#
#   pyinstaller vid2log_sidecar.spec --noconfirm
#
# Run it from inside `python_sidecar/`, with the venv active (PyInstaller
# freezes whatever's installed in the CURRENT environment — running it
# outside the venv silently produces a bundle missing TensorFlow).
#
# ONE-DIR, not one-file. `--onefile` would produce a single tidy binary, but
# it re-extracts the entire bundle to a temp directory on EVERY launch —
# with TensorFlow that's hundreds of MB and many seconds of startup, every
# time the app opens. One-dir starts near-instantly; the extra folder is
# hidden inside the .app/install directory anyway, so nobody sees it.
#
# Build it on the OS you're shipping to. PyInstaller does not
# cross-compile: a macOS build must happen on macOS, a Windows build on
# Windows. (Same constraint as `flutter build windows`.)

import os
import shutil
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

block_cipher = None

SPEC_DIR = Path(os.path.abspath(SPECPATH))
IS_WINDOWS = sys.platform == "win32"

# ── Bundled resources ─────────────────────────────────────────────────────
# Paths here are (source, destination-inside-bundle). The destination for
# the default model mirrors its source layout, because app/ml/classifier.py
# resolves it as resource_dir()/"app"/"ml"/"default_model".
datas = [
    (str(SPEC_DIR / "app" / "ml" / "default_model"), "app/ml/default_model"),
]


def _find_tesseract():
    """Locates a Tesseract install to copy into the bundle.

    VID2LOG_TESSERACT_DIR wins if set — that's the escape hatch for a
    non-standard install, and what CI would use. Otherwise this looks for
    the usual per-platform locations. The binary alone isn't enough:
    Tesseract needs its `tessdata` language files, which live somewhere
    entirely different in most installs, so both get located and copied
    side by side into `tesseract/` inside the bundle. app/bundle.py then
    points pytesseract at that copy and sets TESSDATA_PREFIX to match.
    """
    override = os.environ.get("VID2LOG_TESSERACT_DIR")
    if override:
        root = Path(override)
        exe = root / ("tesseract.exe" if IS_WINDOWS else "tesseract")
        tessdata = root / "tessdata"
        if exe.is_file() and tessdata.is_dir():
            return exe, tessdata
        raise SystemExit(
            f"VID2LOG_TESSERACT_DIR={override} must contain both "
            f"{exe.name} and a tessdata/ directory."
        )

    exe = shutil.which("tesseract")
    if not exe:
        return None, None
    exe = Path(exe).resolve()

    # Homebrew keeps tessdata in ../share/tessdata relative to the binary
    # (via the Cellar symlink); the UB-Mannheim Windows installer keeps it
    # right beside tesseract.exe. Both shapes are checked here.
    candidates = [
        exe.parent.parent / "share" / "tessdata",
        exe.parent / "tessdata",
        Path("/usr/share/tesseract-ocr/5/tessdata"),
        Path("/usr/share/tessdata"),
    ]
    env_prefix = os.environ.get("TESSDATA_PREFIX")
    if env_prefix:
        candidates.insert(0, Path(env_prefix))

    for candidate in candidates:
        if candidate.is_dir() and any(candidate.glob("*.traineddata")):
            return exe, candidate
    return exe, None


tesseract_exe, tessdata_dir = _find_tesseract()
if tesseract_exe is None:
    raise SystemExit(
        "Tesseract wasn't found, so OCR would be broken in the packaged app.\n"
        "  macOS:   brew install tesseract\n"
        "  Windows: install from https://github.com/UB-Mannheim/tesseract/wiki\n"
        "Then re-run, or set VID2LOG_TESSERACT_DIR to a folder containing the "
        "binary and a tessdata/ directory."
    )
if tessdata_dir is None:
    raise SystemExit(
        f"Found Tesseract at {tesseract_exe} but no tessdata directory with "
        "*.traineddata files. Without it OCR fails at runtime with "
        "'Error opening data file'. Set TESSDATA_PREFIX or "
        "VID2LOG_TESSERACT_DIR and re-run."
    )

# The binary goes in as DATA rather than a binary: PyInstaller's binary
# handling tries to rewrite the dependencies of anything in `binaries`, and
# Tesseract is a self-contained CLI we just want copied verbatim.
datas.append((str(tesseract_exe), "tesseract"))
datas.append((str(tessdata_dir), "tesseract/tessdata"))

# ── Dependencies PyInstaller can't see by itself ──────────────────────────
# These packages load submodules dynamically (or ship data files that static
# analysis misses), so collect_all is used to pull in everything rather than
# chasing individual hidden imports.
hiddenimports = [
    # Our own package. run.py imports `app.main` directly (rather than
    # letting uvicorn resolve it from a string), so analysis does find it —
    # but several modules underneath are reached only through lazy,
    # in-function imports (training_pipeline, action_discovery, analytics),
    # and collect_submodules guarantees every one of them ships regardless.
    *collect_submodules("app"),
    # uvicorn resolves its protocol/loop implementations by string name at
    # runtime, so none of them appear in the import graph.
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    # Imported lazily inside functions (see training_pipeline / analytics),
    # which likewise keeps them out of the static graph.
    "tensorflow",
    "tf_keras",
    "scipy.stats",
    "scipy.special",
    "sklearn.cluster",
    "sklearn.preprocessing",
    "sklearn.metrics",
    "sklearn.model_selection",
]

binaries = []
for package in ("tensorflow", "tf_keras", "sklearn", "scipy", "cv2", "PIL"):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(package)
    if package == "tensorflow":
        # tensorflow/include/** ships C++ headers used only for compiling
        # custom ops — never needed by a frozen runtime. They're also the
        # deepest, longest paths in the whole bundle (gRPC/envoy proto
        # trees nested many levels down), which on Windows blows past the
        # 260-char MAX_PATH and makes Copy-Item fail with
        # "Could not find a part of the path" when staging the sidecar
        # next to Vid2Log.exe. Drop them; nothing at runtime imports them.
        pkg_datas = [
            (src, dest) for (src, dest) in pkg_datas
            if not dest.replace("\\", "/").startswith("tensorflow/include")
        ]
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

# joblib ships parallel-backend plugins that are resolved by name.
datas += collect_data_files("joblib")


a = Analysis(
    ["run.py"],
    pathex=[str(SPEC_DIR)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Trimming what a desktop sidecar never uses. matplotlib/IPython arrive
    # as optional extras of the scientific stack and add tens of MB each;
    # tkinter would additionally require a system Tcl/Tk that may not exist
    # on the target machine.
    #
    # Do NOT add numpy submodules here, however obviously unused they look.
    # `numpy.f2py` was excluded in an earlier version of this spec and broke
    # the build: scipy's array_api_compat does `clone_module("numpy")`,
    # which walks every attribute of the numpy package, so an excluded
    # submodule turns into `ModuleNotFoundError: No module named
    # 'numpy.f2py'` at import time — long before any code that would
    # actually use it.
    excludes=[
        "matplotlib",
        "IPython",
        "notebook",
        "jupyter",
        "tkinter",
        "PyQt5",
        "PySide2",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="vid2log_sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX compression is deliberately off: it's known to corrupt some
    # TensorFlow/numpy shared libraries, and on macOS it invalidates code
    # signatures. The size saving isn't worth a bundle that crashes on
    # someone else's machine.
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="vid2log_sidecar",
)
