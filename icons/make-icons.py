"""Rebuild the app icons from the ScorePad logo artwork.

The source is a rounded tile sitting on a white background with a drop shadow.
Rather than guessing the corner radius (it's a squircle, not a circular arc),
the mask is derived from the artwork: flood-fill the light background inward
from the edges, and whatever it can't reach is the tile.
"""

from collections import deque

from PIL import Image

SRC = "logo-source.png"   # master artwork, kept alongside
OUT = "."

# Tile bounds measured from the artwork, squared off around its centre so the
# shadow that bleeds past the bottom edge isn't baked in.
BBOX = (122, 117, 1131, 1136)
BG_LUM = 140  # white page and its soft shadow sit well above this; the tile far below


def luminance(p):
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


def square_crop(im, bbox):
    left, top, right, bottom = bbox
    cx, cy = (left + right) / 2, (top + bottom) / 2
    side = min(right - left + 1, bottom - top + 1)
    half = side / 2
    return im.crop((round(cx - half), round(cy - half), round(cx + half), round(cy + half)))


def background_mask(im):
    """255 for tile, 0 for the page behind it."""
    w, h = im.size
    px = im.load()
    outside = bytearray(w * h)

    queue = deque()
    for x in range(w):
        for y in (0, h - 1):
            queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        if not (0 <= x < w and 0 <= y < h) or outside[y * w + x]:
            continue
        if luminance(px[x, y]) <= BG_LUM:
            continue  # reached the tile
        outside[y * w + x] = 1
        queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))

    mask = Image.new("L", (w, h))
    mask.putdata([0 if v else 255 for v in outside])
    return mask


source = Image.open(SRC).convert("RGB")
tile = square_crop(source, BBOX)
mask = background_mask(tile)

# Flatten onto the tile's own colour first, so the white page never bleeds through
# the antialiased edge when the mask is softened by downscaling.
tile_colour = tile.getpixel((tile.width // 2, 12))
flat = Image.new("RGB", tile.size, tile_colour)
flat.paste(tile, mask=mask)

# Rounded icons: transparent outside the tile.
for size in (192, 512):
    icon = flat.resize((size, size), Image.LANCZOS)
    icon.putalpha(mask.resize((size, size), Image.LANCZOS))
    icon.save(f"{OUT}/icon-{size}.png")

# iOS applies its own rounding, so this one is a full-bleed opaque square.
apple = Image.new("RGB", tile.size, tile_colour)
apple.paste(tile, mask=mask)
apple.resize((180, 180), Image.LANCZOS).save(f"{OUT}/apple-touch-icon.png")

print("tile colour #%02X%02X%02X" % tile_colour)
print("wrote icon-192.png, icon-512.png, apple-touch-icon.png")
