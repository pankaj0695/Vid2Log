"""
Builds assets/app_icon.png — a 1024x1024 master for flutter_launcher_icons.

    python_sidecar/.venv/bin/python3 scripts/make_app_icon.py ../frontend/public/icon-512.png

Why this exists rather than just pointing flutter_launcher_icons at the raw
logo: macOS icons are drawn on a 1024x1024 canvas but the artwork itself is
expected to fill only about 80% of it, with transparent margin around the
edges. Every system app follows that convention, so an icon that fills its
canvas edge-to-edge renders visibly LARGER than its neighbours in the Dock
and Launchpad — which is exactly what a bare logo does.

Apple's own template puts a squircle at 824x824 within the 1024 canvas
(~80.5%), which is where the default scale below comes from.

Uses Pillow, which the sidecar's venv already has — no new dependency.
"""
import sys
from pathlib import Path

from PIL import Image

CANVAS = 1024

# Fraction of the canvas the artwork should span. 0.80 matches Apple's
# macOS icon grid. Nudge it down if the logo still reads large next to
# other apps, or up for a mark with lots of internal whitespace.
SCALE = 0.80


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(1)

    src_path = Path(sys.argv[1]).expanduser().resolve()
    if not src_path.is_file():
        raise SystemExit(f"Source image not found: {src_path}")

    project_root = Path(__file__).resolve().parent.parent
    out_path = project_root / "assets" / "app_icon.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    src = Image.open(src_path).convert("RGBA")
    if min(src.size) < 256:
        print(
            f"Warning: {src_path.name} is only {src.size[0]}x{src.size[1]}. "
            "It'll be upscaled to fit a 1024 canvas and may look soft — "
            "use the largest version of the logo you have."
        )

    target = int(CANVAS * SCALE)
    # thumbnail() only shrinks, so resize explicitly to handle sources
    # smaller than the target too. Aspect ratio is preserved: a non-square
    # logo stays non-square, just bounded by the target box.
    ratio = min(target / src.width, target / src.height)
    resized = src.resize(
        (max(1, round(src.width * ratio)), max(1, round(src.height * ratio))),
        Image.LANCZOS,
    )

    # Fully transparent canvas — macOS applies its own shadow and masking,
    # and a baked-in background would fight with that.
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(
        resized,
        ((CANVAS - resized.width) // 2, (CANVAS - resized.height) // 2),
        resized,
    )
    canvas.save(out_path, "PNG")

    print(f"Wrote {out_path} ({CANVAS}x{CANVAS}, artwork {resized.width}x{resized.height})")
    print("Now run:  dart run flutter_launcher_icons")


if __name__ == "__main__":
    main()
