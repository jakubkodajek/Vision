#!/usr/bin/env python3
"""Render every Vision app icon and the macOS DMG background from one SVG source.

Source: src-tauri/icons/source/vision-mark.svg (same geometry as LogoMark in
src/components/primitives.tsx). Outputs, all checked in:

  src-tauri/icons/32x32.png, 64x64.png, 128x128.png, 128x128@2x.png, icon.png (512)
      full-bleed tile for Linux, Windows and the window icon
  src-tauri/icons/icon.ico      16-256 px, PNG entries
  src-tauri/icons/icon.icns     16-1024 px, PNG entries, macOS icon grid
                                (824 px tile on a 1024 px canvas, drop shadow)
  src-tauri/icons/dmg/background.png, background@2x.png
                                660x400 and 1320x800 DMG window background

Requires Pillow (rendering) and the Inter font from node_modules (run `npm ci` first).
Usage: python3 scripts/make_icons.py [repo-root]
"""

from __future__ import annotations

import io
import math
import re
import struct
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SVG_NS = "{http://www.w3.org/2000/svg}"
SUPERSAMPLE = 4

# Shared design values (DMG artwork). The accent is the default iris from tokens.css.
ACCENT = (79, 70, 229)
INK = (52, 48, 44)
INK_MUTED = (128, 120, 111)
PAPER_TOP = (249, 247, 243)
PAPER_BOTTOM = (240, 236, 229)

# DMG window layout in points; tauri.conf.json bundle.macOS.dmg must match.
DMG_SIZE = (660, 400)
DMG_APP = (180, 150)
DMG_APPLICATIONS = (480, 150)
DMG_ICON = 128  # bundle_dmg.sh default icon size


# ---------------------------------------------------------------- SVG source


@dataclass
class Gradient:
    """Vertical or arbitrary two-point linear gradient in viewBox units."""

    x1: float
    y1: float
    x2: float
    y2: float
    stops: list[tuple[float, tuple[int, int, int]]]


@dataclass
class Shape:
    """One drawable element of the mark."""

    kind: str  # rect | path | circle
    attrs: dict[str, str]


def hex_rgb(value: str) -> tuple[int, int, int]:
    """Parse #rrggbb."""
    m = re.fullmatch(r"#([0-9a-fA-F]{6})", value.strip())
    if not m:
        raise ValueError(f"unsupported colour {value!r}: use #rrggbb")
    h = m.group(1)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def load_svg(path: Path) -> tuple[float, dict[str, Gradient], list[Shape]]:
    """Read the mark: viewBox size, gradients by id, shapes in paint order."""
    root = ET.parse(path).getroot()
    vb = [float(v) for v in root.attrib["viewBox"].split()]
    if vb[0] != 0 or vb[1] != 0 or vb[2] != vb[3]:
        raise ValueError("viewBox must be square and start at 0 0")
    gradients: dict[str, Gradient] = {}
    for g in root.iter(f"{SVG_NS}linearGradient"):
        stops = [
            (float(s.attrib["offset"]), hex_rgb(s.attrib["stop-color"]))
            for s in g.iter(f"{SVG_NS}stop")
        ]
        gradients[g.attrib["id"]] = Gradient(
            float(g.attrib["x1"]),
            float(g.attrib["y1"]),
            float(g.attrib["x2"]),
            float(g.attrib["y2"]),
            stops,
        )
    shapes = []
    for el in root:
        tag = el.tag.removeprefix(SVG_NS)
        if tag in ("rect", "path", "circle"):
            shapes.append(Shape(tag, dict(el.attrib)))
        elif tag not in ("defs",):
            raise ValueError(f"unsupported element <{tag}>")
    return vb[2], gradients, shapes


def path_points(d: str, steps: int = 48) -> list[tuple[float, float]]:
    """Flatten an SVG path using M, L, C, S (absolute or relative) into points."""
    tokens = re.findall(r"[MmLlCcSsZz]|-?(?:\d+\.?\d*|\.\d+)", d)
    pts: list[tuple[float, float]] = []
    cur = (0.0, 0.0)
    last_ctrl: tuple[float, float] | None = None
    i = 0
    cmd = ""

    def num() -> float:
        nonlocal i
        v = float(tokens[i])
        i += 1
        return v

    def cubic(p0, p1, p2, p3):
        for k in range(1, steps + 1):
            t = k / steps
            a = (1 - t) ** 3
            b = 3 * (1 - t) ** 2 * t
            c = 3 * (1 - t) * t**2
            e = t**3
            pts.append(
                (
                    a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0],
                    a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1],
                )
            )

    while i < len(tokens):
        if re.fullmatch(r"[A-Za-z]", tokens[i]):
            cmd = tokens[i]
            i += 1
        rel = cmd.islower()
        ox, oy = cur if rel else (0.0, 0.0)
        c = cmd.lower()
        if c == "m":
            cur = (ox + num(), oy + num())
            pts.append(cur)
            last_ctrl = None
            cmd = "l" if rel else "L"
        elif c == "l":
            cur = (ox + num(), oy + num())
            pts.append(cur)
            last_ctrl = None
        elif c == "c":
            p1 = (ox + num(), oy + num())
            p2 = (ox + num(), oy + num())
            p3 = (ox + num(), oy + num())
            cubic(cur, p1, p2, p3)
            cur, last_ctrl = p3, p2
        elif c == "s":
            p1 = (2 * cur[0] - last_ctrl[0], 2 * cur[1] - last_ctrl[1]) if last_ctrl else cur
            p2 = (ox + num(), oy + num())
            p3 = (ox + num(), oy + num())
            cubic(cur, p1, p2, p3)
            cur, last_ctrl = p3, p2
        elif c == "z":
            if pts:
                pts.append(pts[0])
        else:
            raise ValueError(f"unsupported path command {cmd!r}")
    return pts


# ---------------------------------------------------------------- rendering


def gradient_fill(size: int, grad: Gradient, to_px) -> Image.Image:
    """An RGBA image of the gradient over the whole canvas."""
    (x1, y1), (x2, y2) = to_px(grad.x1, grad.y1), to_px(grad.x2, grad.y2)
    dx, dy = x2 - x1, y2 - y1
    length2 = dx * dx + dy * dy or 1.0
    # Gradients in the mark are axis-aligned; compute per row/column for speed.
    img = Image.new("RGBA", (size, size))
    if abs(dx) < 1e-9:
        line = Image.new("RGBA", (1, size))
        for y in range(size):
            t = min(max(((y + 0.5) - y1) * dy / length2, 0.0), 1.0)
            line.putpixel((0, y), (*lerp_stops(grad.stops, t), 255))
        return line.resize((size, size), Image.Resampling.NEAREST)
    for y in range(size):
        for x in range(size):
            t = (((x + 0.5) - x1) * dx + ((y + 0.5) - y1) * dy) / length2
            img.putpixel((x, y), (*lerp_stops(grad.stops, min(max(t, 0.0), 1.0)), 255))
    return img


def lerp_stops(stops, t: float) -> tuple[int, int, int]:
    """Colour at t along the gradient stops."""
    if t <= stops[0][0]:
        return stops[0][1]
    for (o0, c0), (o1, c1) in zip(stops, stops[1:]):
        if t <= o1:
            u = (t - o0) / ((o1 - o0) or 1.0)
            return tuple(round(a + (b - a) * u) for a, b in zip(c0, c1))  # type: ignore[return-value]
    return stops[-1][1]


def render_mark(
    svg: Path,
    canvas: int,
    tile_origin: float,
    tile_size: float,
    rx_override: float | None = None,
    shadow: bool = False,
) -> Image.Image:
    """Render the mark with its tile at (origin, origin, size) on a square canvas."""
    vb, gradients, shapes = load_svg(svg)
    ss = canvas * SUPERSAMPLE
    scale = tile_size * SUPERSAMPLE / vb
    off = tile_origin * SUPERSAMPLE

    def to_px(x: float, y: float) -> tuple[float, float]:
        return off + x * scale, off + y * scale

    out = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))

    def paint(mask: Image.Image, fill: str) -> None:
        nonlocal out
        m = re.fullmatch(r"url\(#([\w-]+)\)", fill)
        if m:
            layer = gradient_fill(ss, gradients[m.group(1)], to_px)
        else:
            layer = Image.new("RGBA", (ss, ss), (*hex_rgb(fill), 255))
        layer.putalpha(mask)
        out = Image.alpha_composite(out, layer)

    for shape in shapes:
        a = shape.attrs
        mask = Image.new("L", (ss, ss), 0)
        draw = ImageDraw.Draw(mask)
        if shape.kind == "rect":
            x0, y0 = to_px(float(a.get("x", 0)), float(a.get("y", 0)))
            x1, y1 = to_px(
                float(a.get("x", 0)) + float(a["width"]), float(a.get("y", 0)) + float(a["height"])
            )
            rx = rx_override if rx_override is not None else float(a.get("rx", 0))
            draw.rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=rx * scale, fill=255)
            if shadow and a.get("id") == "tile-shape":
                out = Image.alpha_composite(out, drop_shadow(mask, canvas))
            paint(mask, a["fill"])
        elif shape.kind == "circle":
            cx, cy = to_px(float(a["cx"]), float(a["cy"]))
            r = float(a["r"]) * scale
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
            paint(mask, a["fill"])
        elif shape.kind == "path":
            if a.get("fill", "none") != "none" or a.get("stroke-linecap") != "round":
                raise ValueError("paths must be fill=none with round line caps")
            w = float(a["stroke-width"]) * scale
            pts = [to_px(x, y) for x, y in path_points(a["d"])]
            stroke_polyline(draw, pts, w)
            paint(mask, a["stroke"])
    return out.resize((canvas, canvas), Image.Resampling.LANCZOS)


def stroke_polyline(draw: ImageDraw.ImageDraw, pts: list[tuple[float, float]], w: float) -> None:
    """Stroke with round joins and caps: a quad per segment plus a disc per vertex."""
    r = w / 2
    for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
        length = math.hypot(xb - xa, yb - ya)
        if length == 0:
            continue
        nx, ny = -(yb - ya) / length * r, (xb - xa) / length * r
        draw.polygon([(xa + nx, ya + ny), (xb + nx, yb + ny), (xb - nx, yb - ny), (xa - nx, ya - ny)], fill=255)
    for x, y in pts:
        draw.ellipse((x - r, y - r, x + r, y + r), fill=255)


def drop_shadow(mask: Image.Image, canvas: int) -> Image.Image:
    """Soft shadow under the tile, as in Apple's macOS icon template."""
    ss = mask.size[0]
    unit = ss / 1024  # values below are for a 1024 px canvas
    shifted = Image.new("L", mask.size, 0)
    shifted.paste(mask, (0, round(10 * unit)))
    blurred = shifted.filter(ImageFilter.GaussianBlur(10 * unit))
    alpha = blurred.point(lambda v: round(v * 0.30))
    layer = Image.new("RGBA", mask.size, (0, 0, 0, 255))
    layer.putalpha(alpha)
    return layer


def png_bytes(img: Image.Image) -> bytes:
    """Encode as PNG without metadata."""
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_icns(path: Path, render) -> None:
    """ICNS with PNG payloads for every size macOS looks up."""
    entries = [
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
        (b"ic11", 32),
        (b"ic12", 64),
        (b"ic13", 256),
        (b"ic14", 512),
    ]
    cache: dict[int, bytes] = {}
    body = b""
    for tag, px in entries:
        data = cache.setdefault(px, png_bytes(render(px)))
        body += tag + struct.pack(">I", len(data) + 8) + data
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def write_ico(path: Path, render, sizes=(16, 24, 32, 48, 64, 128, 256)) -> None:
    """ICO with PNG payloads (Windows Vista and later)."""
    images = [png_bytes(render(s)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = len(header) + 16 * len(sizes)
    directory = b""
    for s, data in zip(sizes, images):
        dim = 0 if s >= 256 else s
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    path.write_bytes(header + directory + b"".join(images))


# ---------------------------------------------------------------- DMG background


def font(root: Path, px: float, weight: str) -> ImageFont.FreeTypeFont:
    """Inter (variable) from the npm package the UI already bundles."""
    f = ImageFont.truetype(
        str(root / "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
        round(px),
    )
    f.set_variation_by_name(weight)
    return f


def dmg_background(root: Path, scale: int) -> Image.Image:
    """The DMG window background at 1x or 2x; layout in points from DMG_* above."""
    k = scale * SUPERSAMPLE
    w, h = DMG_SIZE[0] * k, DMG_SIZE[1] * k
    img = Image.new("RGBA", (w, h))
    col = Image.new("RGBA", (1, h))
    for y in range(h):
        t = y / (h - 1)
        col.putpixel(
            (0, y),
            (*(round(a + (b - a) * t) for a, b in zip(PAPER_TOP, PAPER_BOTTOM)), 255),
        )
    img.paste(col.resize((w, h), Image.Resampling.NEAREST))

    draw = ImageDraw.Draw(img)
    # Arrow from the app icon towards Applications, clear of both 128 pt icons.
    y = DMG_APP[1] * k
    gap = (DMG_ICON / 2 + 30) * k
    x0, x1 = DMG_APP[0] * k + gap, DMG_APPLICATIONS[0] * k - gap
    stroke = 3 * k
    head = 12 * k
    colour = (*ACCENT, 255)
    draw.line((x0, y, x1 - stroke / 2, y), fill=colour, width=stroke)
    for dy in (-head, head):
        draw.line((x1 - head, y + dy, x1, y), fill=colour, width=stroke)
    for px, py in ((x0, y), (x1, y), (x1 - head, y - head), (x1 - head, y + head)):
        r = stroke / 2
        draw.ellipse((px - r, py - r, px + r, py + r), fill=colour)

    title = "Drag Vision to Applications"
    sub = "Then open Vision from your Applications folder."
    cx = DMG_SIZE[0] / 2 * k
    draw.text((cx, 280 * k), title, font=font(root, 17 * k, "SemiBold"), fill=(*INK, 255), anchor="ms")
    draw.text((cx, 303 * k), sub, font=font(root, 12.5 * k, "Regular"), fill=(*INK_MUTED, 255), anchor="ms")

    out = img.resize((DMG_SIZE[0] * scale, DMG_SIZE[1] * scale), Image.Resampling.LANCZOS)
    return out.convert("RGB")


# ---------------------------------------------------------------- main


def main(root: Path) -> None:
    """Write every icon and DMG asset under src-tauri/icons."""
    icons = root / "src-tauri/icons"
    svg = icons / "source/vision-mark.svg"

    def flat(px: int) -> Image.Image:
        # Full-bleed tile with a 1/32 margin: reads well at 16-32 px on Windows/Linux.
        margin = px / 32
        return render_mark(svg, px, margin, px - 2 * margin)

    def macos(px: int) -> Image.Image:
        # Apple macOS icon grid: 824 px tile, corner radius ~185 px, on a 1024 px canvas.
        unit = px / 1024
        vb = load_svg(svg)[0]
        return render_mark(svg, px, 100 * unit, 824 * unit, rx_override=185.4 / 824 * vb, shadow=True)

    for name, px in (
        ("32x32.png", 32),
        ("64x64.png", 64),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 512),
    ):
        (icons / name).write_bytes(png_bytes(flat(px)))
    write_ico(icons / "icon.ico", flat)
    write_icns(icons / "icon.icns", macos)

    dmg = icons / "dmg"
    dmg.mkdir(exist_ok=True)
    (dmg / "background.png").write_bytes(png_bytes(dmg_background(root, 1)))
    (dmg / "background@2x.png").write_bytes(png_bytes(dmg_background(root, 2)))
    print(f"wrote icons and DMG background under {icons}")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent)
