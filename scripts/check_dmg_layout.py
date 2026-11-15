#!/usr/bin/env python3
"""Check the Finder layout stored in a mounted DMG's .DS_Store. Stdlib only.

Usage: check_dmg_layout.py <mounted-volume> <tauri.conf.json>

The layout (icon positions, background) only exists if Finder ran the bundler's
AppleScript and wrote .DS_Store. This script fails when the file is missing or has no
icon location ("Iloc") records for the app and the Applications link, and prints the
stored positions next to the configured ones.
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path


def iloc_records(ds_store: bytes) -> dict[str, tuple[int, int]]:
    """Return {filename: (x, y)} for every Iloc record in a .DS_Store file.

    A record is: uint32 name length (UTF-16 code units), UTF-16BE name, b"Iloc",
    b"blob", uint32 blob length (16), uint32 x, uint32 y, 8 bytes of padding.
    """
    found: dict[str, tuple[int, int]] = {}
    marker = b"Ilocblob"
    start = 0
    while (pos := ds_store.find(marker, start)) != -1:
        start = pos + 1
        blob = ds_store[pos + 8 : pos + 8 + 12]
        if len(blob) < 12:
            continue
        length, x, y = struct.unpack(">III", blob)
        if length != 16:
            continue
        # Walk back to the name: try plausible lengths and keep the one that fits.
        for n in range(1, 256):
            head = pos - 2 * n - 4
            if head < 0:
                break
            if struct.unpack(">I", ds_store[head : head + 4])[0] == n:
                try:
                    name = ds_store[head + 4 : pos].decode("utf-16-be")
                except UnicodeDecodeError:
                    continue
                found[name] = (x, y)
                break
    return found


def main(volume: Path, config_path: Path) -> int:
    """Validate the layout; return a process exit code."""
    conf = json.loads(config_path.read_text(encoding="utf-8"))
    product = conf["productName"]
    dmg = conf["bundle"]["macOS"]["dmg"]
    expected = {
        f"{product}.app": (dmg["appPosition"]["x"], dmg["appPosition"]["y"]),
        "Applications": (
            dmg["applicationFolderPosition"]["x"],
            dmg["applicationFolderPosition"]["y"],
        ),
    }
    ds = volume / ".DS_Store"
    if not ds.is_file():
        print(f"::error::{ds} is missing: Finder did not store a layout (icon positions, background)")
        return 1
    records = iloc_records(ds.read_bytes())
    ok = True
    for name, want in expected.items():
        got = records.get(name)
        if got is None:
            print(f"::error::no icon position stored for {name!r} (records: {sorted(records)})")
            ok = False
            continue
        print(f"{name}: stored {got}, configured {want}")
        if got != want:
            print(f"::warning::{name} is at {got}, configured {want}")
    background = list((volume / ".background").glob("*")) if (volume / ".background").is_dir() else []
    if not background:
        print("::error::no background image in .background/")
        ok = False
    else:
        print("background:", ", ".join(p.name for p in background))
    if ok:
        app, apps = records[f"{product}.app"], records["Applications"]
        if not (app[0] < apps[0] and app[1] == apps[1]):
            print(f"::error::unexpected layout: app {app}, Applications {apps}")
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1]), Path(sys.argv[2])))
