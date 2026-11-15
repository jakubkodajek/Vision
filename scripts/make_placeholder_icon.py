#!/usr/bin/env python3
"""Write a 1024x1024 geometric placeholder icon (rounded square with a V). Stdlib only."""
import struct
import sys
import zlib

SIZE = 1024
BG = (38, 50, 72, 255)
FG = (240, 240, 235, 255)
CLEAR = (0, 0, 0, 0)
RADIUS = 200


def in_rounded_square(x: int, y: int) -> bool:
    cx = min(max(x, RADIUS), SIZE - 1 - RADIUS)
    cy = min(max(y, RADIUS), SIZE - 1 - RADIUS)
    return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS**2


def in_v(x: int, y: int) -> bool:
    top, bottom = 260, 780
    if not top <= y <= bottom:
        return False
    t = (y - top) / (bottom - top)
    half = 250 * (1 - t) + 40 * t  # distance of arm centre from the axis
    thick = 70
    return abs(abs(x - SIZE / 2) - half) <= thick


def chunk(tag: bytes, data: bytes) -> bytes:
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def main(out: str) -> None:
    rows = bytearray()
    for y in range(SIZE):
        rows.append(0)
        for x in range(SIZE):
            px = CLEAR
            if in_rounded_square(x, y):
                px = FG if in_v(x, y) else BG
            rows.extend(px)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    png += chunk(b"IEND", b"")
    with open(out, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "src-tauri/icons/source.png")
