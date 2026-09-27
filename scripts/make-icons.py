#!/usr/bin/env python3
"""
scripts/make-icons.py — draws the OXIS logo (assets/logo.svg: a hexagon
ring with two shaded facets) at every icon size, and writes

  cmd/oxi/oxis.ico            the .exe / MSI / shortcut icon
  frontend/public/favicon.ico the window and tab icon
  frontend/public/logo.png    512x512 (Linux desktop icon, data folder)

Each size is drawn from the logo's own geometry, not scaled down from a
big picture: the ring's vertical edges land on whole pixels, so 16 and
24 px icons stay sharp. Shapes are drawn at 16x and averaged down.
Needs Pillow:  python scripts/make-icons.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GREEN = (0x3D, 0xFF, 0x64, 255)
FACET = (0x2F, 0xC7, 0x4E, 255)   # the green under the logo's 22% black facets
EDGE = (0x16, 0x6B, 0x2C, 255)    # a thin dark rim, so small icons read on light backgrounds too
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SS = 16  # supersampling


def draw_logo(size):
    """The logo on a transparent size x size square."""
    pad = max(1, round(size / 16))
    h = size - 2 * pad
    w = round(h * 0.74)
    if (size - w) % 2:          # centre on whole pixels
        w -= 1
    x0, y0 = (size - w) // 2, pad
    # The ring's side thickness in whole pixels; at least 3 so the
    # smallest icons still read as a ring.
    ring = max(3 if size <= 24 else 2, round(w * 0.25))
    # The logo's y positions (0..100), scaled to this height.
    Y = lambda v: y0 + h * v / 100
    L, R, C = x0, x0 + w, x0 + w / 2
    iL, iR = x0 + ring, x0 + w - ring
    outer = [(C, Y(0)), (R, Y(19)), (R, Y(81)), (C, Y(100)), (L, Y(81)), (L, Y(19))]
    inner = [(C, Y(19)), (iL, Y(28.6)), (iL, Y(71)), (C, Y(80.4)), (iR, Y(71)), (iR, Y(28.6))]
    facets = [
        [(iL, Y(9.8)), (C, Y(19)), (iL, Y(28.6))],
        [(iR, Y(70.9)), (C, Y(80.4)), (iR, Y(90))],
    ]
    big = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    s = lambda pts: [(x * SS, y * SS) for x, y in pts]
    # A thin dark rim on small icons only (taskbar, title bar, Explorer
    # lists), where bright green alone gets lost on a light background.
    rim = 0 if size > 64 else (SS // 2 if size <= 24 else SS)
    if rim:
        d.polygon(s(outer), fill=EDGE)
        d.polygon(shrink(s(outer), rim), fill=GREEN)
    else:
        d.polygon(s(outer), fill=GREEN)
    if size >= 32:
        for f in facets:
            d.polygon(s(f), fill=FACET)
    if rim:
        d.polygon(grow(s(inner), rim), fill=EDGE)
    d.polygon(s(inner), fill=(0, 0, 0, 0))
    return big.resize((size, size), Image.BOX)


def centroid(pts):
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def shrink(pts, by):
    """Moves each point `by` towards the centre (good enough for these
    convex hexagons at the rim widths used)."""
    cx, cy = centroid(pts)
    out = []
    for x, y in pts:
        dx, dy = cx - x, cy - y
        n = (dx * dx + dy * dy) ** 0.5 or 1
        out.append((x + dx / n * by, y + dy / n * by))
    return out


def grow(pts, by):
    return shrink(pts, -by)


def main():
    images = {s: draw_logo(s) for s in SIZES}
    for rel in ("cmd/oxi/oxis.ico", "frontend/public/favicon.ico"):
        path = os.path.join(ROOT, rel)
        images[256].save(path, format="ICO", sizes=[(s, s) for s in SIZES],
                         append_images=[images[s] for s in SIZES[:-1]])
        print("wrote", rel)
    draw_logo(512).save(os.path.join(ROOT, "frontend/public/logo.png"), optimize=True)
    print("wrote frontend/public/logo.png")


if __name__ == "__main__":
    import sys
    if "--preview" in sys.argv:
        out = sys.argv[sys.argv.index("--preview") + 1]
        rows = []
        for bg in [(30, 30, 36, 255), (243, 243, 243, 255), (0, 90, 158, 255)]:
            row = Image.new("RGBA", (sum(SIZES) + 12 * len(SIZES) + 12, 270), bg)
            x = 12
            for s in SIZES:
                row.alpha_composite(draw_logo(s), (x, 8))
                x += s + 12
            rows.append(row)
        sheet = Image.new("RGBA", (rows[0].width, 270 * len(rows)))
        for i, r in enumerate(rows):
            sheet.paste(r, (0, 270 * i))
        sheet.save(out)
        # 6x zoom of 16/20/24/32 to see the pixels
        z = Image.new("RGBA", (6 * (16 + 20 + 24 + 32) + 60, 6 * 32 + 20), (30, 30, 36, 255))
        x = 10
        for s in (16, 20, 24, 32):
            z.alpha_composite(draw_logo(s).resize((s * 6, s * 6), Image.NEAREST), (x, 10))
            x += s * 6 + 12
        z.save(out.replace(".png", "-zoom.png"))
        print("preview", out)
    else:
        main()
