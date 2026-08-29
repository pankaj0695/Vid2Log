"""
Where things live once the sidecar is frozen into a standalone executable.

Running from source and running from a PyInstaller bundle differ in two
ways that matter, and this module is the single place that knows about
either of them:

  * `sys.frozen` / `sys._MEIPASS` — PyInstaller unpacks bundled data files
    into a temp directory at startup (one-file mode) or places them next to
    the executable (one-dir mode). `resource_dir()` returns whichever
    applies, so `app/ml/default_model/` and the bundled Tesseract are found
    the same way in both.
  * `__file__`-relative paths stop meaning what they used to. Anything that
    resolves a path from `Path(__file__).parent` works fine from source and
    silently points into the wrong place — or nowhere — once frozen.

USER DATA (the SQLite db, trained models, action datasets) deliberately
does NOT live here: it belongs in the user's home directory
(app/config.py's APP_DATA_DIR), not inside the app bundle. On macOS the
bundle sits in /Applications and is read-only for a normal user; on
Windows it's under Program Files with the same problem. Writing there
would also mean an app update wipes everything the user made.
"""
import os
import sys
from pathlib import Path


def is_frozen() -> bool:
    """True when running from a PyInstaller bundle rather than source."""
    return getattr(sys, "frozen", False)


def resource_dir() -> Path:
    """Root directory for bundled read-only resources.

    In one-file mode PyInstaller sets `sys._MEIPASS` to the temp extraction
    directory; in one-dir mode it doesn't, and resources sit alongside the
    executable. Falling back to the package directory covers running from
    source, where "bundled resources" are simply the repo's own files.
    """
    if is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).parent
    # From source: python_sidecar/ (this file's parent's parent).
    return Path(__file__).resolve().parent.parent


def tesseract_paths() -> tuple[Path | None, Path | None]:
    """(tesseract executable, tessdata directory) for the bundled copy, or
    (None, None) when there isn't one — in which case `pytesseract` falls
    back to whatever `tesseract` is on PATH, which is the right behaviour
    when running from source on a dev machine that has it installed.
    """
    root = resource_dir() / "tesseract"
    if not root.is_dir():
        return None, None

    exe = root / ("tesseract.exe" if sys.platform == "win32" else "tesseract")
    tessdata = root / "tessdata"
    if not exe.is_file():
        return None, None
    return exe, (tessdata if tessdata.is_dir() else None)


def configure_tesseract() -> None:
    """Points pytesseract at the bundled Tesseract, if one shipped with this
    build. Called once at import time from app/ml/ocr.py.

    TESSDATA_PREFIX has to be set too: Tesseract locates its language data
    through that environment variable, and a relocated binary has no way to
    guess where its `tessdata` ended up. Without it OCR fails at runtime
    with "Error opening data file ... eng.traineddata", even though the
    executable itself launches fine.
    """
    exe, tessdata = tesseract_paths()
    if exe is None:
        return

    import pytesseract

    pytesseract.pytesseract.tesseract_cmd = str(exe)
    if tessdata is not None:
        os.environ.setdefault("TESSDATA_PREFIX", str(tessdata))
