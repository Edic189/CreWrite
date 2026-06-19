#!/usr/bin/env python3
"""Generate placeholder CreWrite app icons (solid accent color) with stdlib only.

Produces the files referenced by tauri.conf.json's bundle.icon:
  icons/32x32.png, icons/128x128.png, icons/128x128@2x.png,
  icons/icon.png, icons/icon.icns, icons/icon.ico
Replace later with real art via `cargo tauri icon ./app-icon.png`.
"""
import os
import struct
import subprocess
import tempfile
import zlib

COLOR = (79, 163, 255, 255)  # --accent blue, RGBA
ICONS = os.path.join(os.path.dirname(__file__), "icons")


def make_png(w: int, h: int, rgba=COLOR) -> bytes:
    """Encode a solid-color w×h RGBA PNG (8-bit, color type 6)."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    pixel = bytes(rgba)
    row = b"\x00" + pixel * w          # filter byte 0 + scanline
    raw = row * h
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def write_png(path: str, size: int) -> None:
    with open(path, "wb") as f:
        f.write(make_png(size, size))


def make_ico(path: str, png_bytes: bytes) -> None:
    """Wrap a 256×256 PNG into a Vista-style PNG-in-ICO container."""
    icondir = struct.pack("<HHH", 0, 1, 1)          # reserved, type=icon, count
    entry = struct.pack(
        "<BBBBHHII",
        0, 0,            # width/height 0 => 256
        0, 0,            # colors, reserved
        1, 32,           # planes, bit depth
        len(png_bytes),  # size of image data
        6 + 16,          # offset to image data
    )
    with open(path, "wb") as f:
        f.write(icondir + entry + png_bytes)


def make_icns(path: str) -> None:
    """Build .icns via a temp .iconset + macOS iconutil."""
    names = {
        "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
    }
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for name, size in names.items():
            write_png(os.path.join(iconset, name), size)
        subprocess.run(
            ["iconutil", "-c", "icns", iconset, "-o", path], check=True
        )


def main() -> None:
    os.makedirs(ICONS, exist_ok=True)
    write_png(os.path.join(ICONS, "32x32.png"), 32)
    write_png(os.path.join(ICONS, "128x128.png"), 128)
    write_png(os.path.join(ICONS, "128x128@2x.png"), 256)
    write_png(os.path.join(ICONS, "icon.png"), 512)
    make_ico(os.path.join(ICONS, "icon.ico"), make_png(256, 256))
    make_icns(os.path.join(ICONS, "icon.icns"))
    print("icons written to", ICONS)


if __name__ == "__main__":
    main()
