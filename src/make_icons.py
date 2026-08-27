#!/usr/bin/env python3
"""Generate Owl Hours app icons as PNGs with no third-party deps.

An owl face in KSU gold on near-black: outer disc, two eye rings, a beak.
Rendered at 4x and box-filtered down so the curves stay clean at 48px.
"""
import zlib, struct, os

BG   = (0x14, 0x13, 0x0F)   # near-black, same ground as the app's dark theme
GOLD = (0xE8, 0xB3, 0x3E)   # the app's dark-theme gold
DARK = (0x14, 0x13, 0x0F)

SS = 4  # supersampling factor


def owl_px(x, y, n):
    """Colour of the icon at (x, y) in an n-by-n square, before downsampling."""
    cx = cy = n / 2.0
    r = n / 2.0

    # rounded-square ground, corner radius ~22% (iOS masks its own, others don't)
    pad, rad = n * 0.0, n * 0.22
    dx = max(pad - x, x - (n - pad), 0.0)
    dy = max(pad - y, y - (n - pad), 0.0)
    ix = min(max(x, pad + rad), n - pad - rad)
    iy = min(max(y, pad + rad), n - pad - rad)
    if (x - ix) ** 2 + (y - iy) ** 2 > rad ** 2 and (dx or dy or True):
        # outside the rounded rect -> transparent
        if ((x - ix) ** 2 + (y - iy) ** 2) > rad ** 2:
            return None

    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5

    # gold disc forming the face
    face_r = r * 0.74
    if d > face_r:
        return BG

    # ear tufts: two notches cut out of the top of the disc
    for sx in (-1, 1):
        tx, ty = cx + sx * face_r * 0.62, cy - face_r * 0.86
        if ((x - tx) ** 2 + (y - ty) ** 2) ** 0.5 < face_r * 0.40:
            return BG

    # eyes: dark discs with a gold pupil ring
    eye_dy = -face_r * 0.16
    eye_r = face_r * 0.36
    for sx in (-1, 1):
        ex, ey = cx + sx * face_r * 0.38, cy + eye_dy
        ed = ((x - ex) ** 2 + (y - ey) ** 2) ** 0.5
        if ed < eye_r:
            if ed < eye_r * 0.42:
                return GOLD          # pupil
            return DARK              # eye white -> dark, high contrast
    # beak: small downward triangle between and below the eyes
    by = cy + eye_dy + eye_r * 0.55
    bh = face_r * 0.30
    bw = face_r * 0.15
    if 0 <= y - by <= bh:
        t = (y - by) / bh
        if abs(x - cx) < bw * (1.0 - t):
            return DARK
    return GOLD


def render(size):
    n = size * SS
    # supersample then average each SSxSS block
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    c = owl_px(px * SS + sx + 0.5, py * SS + sy + 0.5, n)
                    if c is None:
                        continue
                    r += c[0]; g += c[1]; b += c[2]; a += 255
            tot = SS * SS
            if a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                cnt = a // 255
                row += bytes((r // cnt, g // cnt, b // cnt, a // tot))
        rows.append(bytes(row))
    return rows


def write_png(path, size, opaque_bg=False):
    rows = render(size)
    if opaque_bg:  # apple-touch-icon must not be transparent
        flat = []
        for row in rows:
            out = bytearray()
            for i in range(0, len(row), 4):
                r, g, b, a = row[i:i + 4]
                f = a / 255.0
                out += bytes((int(r * f + BG[0] * (1 - f)),
                              int(g * f + BG[1] * (1 - f)),
                              int(b * f + BG[2] * (1 - f)), 255))
            flat.append(bytes(out))
        rows = flat

    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    open(path, "wb").write(png)
    return len(png)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(os.path.dirname(here), "icons")
    os.makedirs(out, exist_ok=True)
    for size, name, opaque in [
        (192, "icon-192.png", False),
        (512, "icon-512.png", False),
        (180, "apple-touch-icon.png", True),
        (32,  "favicon-32.png", False),
        (1024, "icon-1024.png", False),   # Electron / macOS source art
    ]:
        n = write_png(os.path.join(out, name), size, opaque)
        print("  %-22s %5d bytes" % (name, n))
