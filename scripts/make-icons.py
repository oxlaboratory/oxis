#!/usr/bin/env python3
"""
scripts/make-icons.py — renders the OXIS logo (assets/logo.svg: a round
O folded like a ribbon, a deep green half and a bright one) at every
icon size, and writes

  cmd/oxi/oxis.ico                    the .exe / MSI / shortcut icon
  frontend/public/favicon.ico         the window and tab icon
  frontend/public/logo.png            512x512 (Linux desktop icon, data folder)
  cloudflare/assets/apple-touch-icon.png  the site's home-screen icon

The SVG is drawn once, large, by a headless Edge or Chrome (so the
gradients and curves come out exactly as in the browser), then scaled
down to each size. Needs Pillow and Edge or Chrome:
  python scripts/make-icons.py
After it, rebuild cmd/oxi/resource_windows.syso (node scripts/build-go.js
does it) so the .exe carries the new icon.
"""
import os
import shutil
import subprocess
import sys
import tempfile
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG = os.path.join(ROOT, "assets", "logo.svg")
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
BIG = 1024

BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def browser():
    for b in BROWSERS + [shutil.which("msedge") or "", shutil.which("chrome") or ""]:
        if b and os.path.exists(b):
            return b
    sys.exit("make-icons: needs Edge or Chrome to render assets/logo.svg")


def render_big():
    """The logo at BIG x BIG on a transparent background."""
    tmp = tempfile.mkdtemp(prefix="oxis-icons-")
    page = os.path.join(tmp, "logo.html")
    svg = open(SVG, encoding="utf-8").read()
    open(page, "w", encoding="utf-8").write(
        f'<!doctype html><html><body style="margin:0;background:transparent">'
        f'<div style="width:{BIG}px;height:{BIG}px">{svg.replace("<svg ", f"<svg style=\"width:{BIG}px;height:{BIG}px;display:block\" ", 1)}</div></body></html>')
    out = os.path.join(tmp, "big.png")
    subprocess.run([browser(), "--headless=new", "--disable-gpu", f"--user-data-dir={os.path.join(tmp, 'p')}",
                    "--default-background-color=00000000", "--hide-scrollbars",
                    f"--window-size={BIG},{BIG}", f"--screenshot={out}", "file:///" + page.replace("\\", "/")],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    img = Image.open(out).convert("RGBA").crop((0, 0, BIG, BIG))
    shutil.rmtree(tmp, ignore_errors=True)
    return img


def scaled(big, size):
    """Scaled down in halves (sharper than one big step), then to size."""
    im = big
    while im.width // 2 >= size * 2:
        im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
    return im.resize((size, size), Image.LANCZOS)


def main():
    big = render_big()
    images = {s: scaled(big, s) for s in SIZES}
    for rel in ("cmd/oxi/oxis.ico", "frontend/public/favicon.ico"):
        images[256].save(os.path.join(ROOT, rel), format="ICO", sizes=[(s, s) for s in SIZES],
                         append_images=[images[s] for s in SIZES[:-1]])
        print("wrote", rel)
    scaled(big, 512).save(os.path.join(ROOT, "frontend/public/logo.png"), optimize=True)
    print("wrote frontend/public/logo.png")
    touch = Image.new("RGBA", (180, 180), (6, 7, 11, 255))
    logo = scaled(big, 132)
    touch.alpha_composite(logo, (24, 24))
    touch.convert("RGB").save(os.path.join(ROOT, "cloudflare/assets/apple-touch-icon.png"), optimize=True)
    print("wrote cloudflare/assets/apple-touch-icon.png")


if __name__ == "__main__":
    main()
