#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 ARNO <arnochen101@gmail.com>
# The Omarchy wallpaper, drawn rather than shipped, so the repository carries no
# image: Tokyo Night's night background, darker towards the bottom, with two soft
# glows in its blue and violet accents, as a PNG. build.sh runs it into the image.
# Usage: wallpaper.py OUT.png [WIDTH HEIGHT]
import math
import struct
import sys
import zlib

TOP = (0x1A, 0x1B, 0x26)
BOTTOM = (0x16, 0x16, 0x1E)
# centre (x, y) and radius as fractions of the width and of the larger side,
# colour, strength
GLOWS = (
    (0.80, 0.18, 0.60, (0x7A, 0xA2, 0xF7), 0.10),
    (0.10, 0.95, 0.50, (0xBB, 0x9A, 0xF7), 0.07),
)


def row(y, width, height):
    t = y / (height - 1)
    base = [a + (b - a) * t for a, b in zip(TOP, BOTTOM)]
    span = max(width, height)
    out = bytearray()
    for x in range(width):
        c = list(base)
        for cx, cy, radius, colour, strength in GLOWS:
            d = math.hypot(x - cx * width, y - cy * height) / (radius * span)
            s = max(0.0, 1.0 - d) ** 2 * strength
            for i in range(3):
                c[i] += (colour[i] - c[i]) * s
        out += bytes(max(0, min(255, round(v))) for v in c)
    return bytes(out)


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png(width, height, rows):
    raw = bytearray()
    prev = bytes(width * 3)
    for r in rows:
        raw.append(2)  # the Up filter: neighbouring rows of a gradient differ little
        raw += bytes((c - p) & 0xFF for c, p in zip(r, prev))
        prev = r
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


def main(argv):
    if len(argv) not in (2, 4):
        print("usage: wallpaper.py OUT.png [WIDTH HEIGHT]", file=sys.stderr)
        return 2
    width, height = (int(argv[2]), int(argv[3])) if len(argv) == 4 else (1920, 1200)
    rows = [row(y, width, height) for y in range(height)]
    with open(argv[1], "wb") as f:
        f.write(png(width, height, rows))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
