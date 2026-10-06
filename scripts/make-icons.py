#!/usr/bin/env python3
"""
scripts/make-icons.py — draws the OXIS logo (assets/logo.svg: a wide
hexagon ring with two shaded facets) at every icon size, and writes

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
# Deep greens, lit from the top left: the ring's right half a shade
# brighter than its left (as if the hexagon were folded down the
# middle), each a gradient from top to bottom; the facets darker still.
RIGHT = ((0x4A, 0xF0, 0x78), (0x16, 0x9E, 0x45))   # top, bottom
LEFT = ((0x2C, 0xC8, 0x5A), (0x0C, 0x6E, 0x30))
FACET = (0x06, 0x3D, 0x1A, 150)   # laid over the ring
EDGE = (0x07, 0x33, 0x16, 255)    # a thin dark rim, so small icons read on light backgrounds too
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SS = 16  # supersampling


# The logo's shape, in its own units: x from -10 to 84 (centre 37), y
# from 0 to 100 — a wide hexagon ring (0.94 as wide as it is tall, so
# it fills an icon's square) with two shaded facets.
LX0, LW = -10, 94
OUTER = [(37, 0), (84, 24), (84, 76), (37, 100), (-10, 76), (-10, 24)]
INNER = [(37, 24), (62, 37), (62, 63), (37, 76), (12, 63), (12, 37)]
FACETS = [[(12, 12.8), (37, 24), (12, 37)], [(62, 63), (37, 76), (62, 87.2)]]


def draw_logo(size):
    """The logo on a transparent size x size square."""
    pad = max(1, round(size / 16))
    h = size - 2 * pad
    w = round(h * LW / 100)
    if (size - w) % 2:          # centre on whole pixels
        w -= 1
    x0, y0 = (size - w) / 2, pad
    P = lambda pts: [(x0 + (x - LX0) * w / LW, y0 + y * h / 100) for x, y in pts]
    outer, inner, facets = P(OUTER), P(INNER), [P(f) for f in FACETS]
    S = size * SS
    s = lambda pts: [(x * SS, y * SS) for x, y in pts]
    # The ring as a mask (with a thin dark rim at small sizes, where a
    # bright shape alone gets lost on a light background).
    rim = 0 if size > 64 else (SS // 2 if size <= 24 else SS)
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.polygon(s(outer), fill=255)
    md.polygon(s(inner), fill=0)
    # The two halves' gradients, split at the centre line.
    def gradient(top, bottom):
        g = Image.new("RGBA", (1, S))
        for yy in range(S):
            t = min(1, max(0, (yy / SS - y0) / h))
            g.putpixel((0, yy), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
        return g.resize((S, S))
    # The smallest sizes a little lighter, so they still read on a dark
    # taskbar.
    lift = (lambda c: tuple(round(v + (255 - v) * 0.18) for v in c)) if size <= 32 else (lambda c: c)
    colour = gradient(*map(lift, RIGHT))
    left = gradient(*map(lift, LEFT))
    cx = round((x0 + (37 - LX0) * w / LW) * SS)
    colour.paste(left.crop((0, 0, cx, S)), (0, 0))
    big = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    if rim:
        big.paste(Image.new("RGBA", (S, S), EDGE), (0, 0), mask)
        inner_mask = Image.new("L", (S, S), 0)
        im = ImageDraw.Draw(inner_mask)
        im.polygon(shrink(s(outer), rim), fill=255)
        im.polygon(grow(s(inner), rim), fill=0)
        big.paste(colour, (0, 0), inner_mask)
    else:
        big.paste(colour, (0, 0), mask)
    if size >= 32:
        shade = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shade)
        for f in facets:
            sd.polygon(s(f), fill=FACET)
        big.alpha_composite(shade)
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
