#!/usr/bin/env python3
"""Derive native and browser icons from assets/brand/easytier.svg using Tauri."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import shlex
import shutil
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zlib


ROOT = Path(__file__).resolve().parents[1]
CANONICAL = ROOT / "assets/brand/easytier.svg"
ICONS = ROOT / "easytier-gui/src-tauri/icons"
ANDROID_RES = ROOT / "easytier-gui/src-tauri/gen/android/app/src/main/res"
PLUGIN_DRAWABLE = ROOT / "tauri-plugin-vpnservice/android/src/main/res/drawable"
ANDROID_NS = "http://schemas.android.com/apk/res/android"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rgba_png(path):
    """Decode Tauri's non-interlaced RGBA8 PNG without an image dependency."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"Not a PNG: {path}")
    offset, compressed, header = 8, bytearray(), None
    while offset < len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        crc = struct.unpack_from(">I", data, offset + 8 + length)[0]
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != crc:
            raise ValueError(f"PNG chunk checksum failed: {path}")
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", payload)
        elif kind == b"IDAT":
            compressed.extend(payload)
        offset += 12 + length
        if kind == b"IEND":
            break
    width, height, depth, colour, compression, filtering, interlace = header
    if (depth, colour, compression, filtering, interlace) != (8, 6, 0, 0, 0):
        raise ValueError(f"Expected Tauri RGBA8 PNG, got {header}: {path}")
    raw, stride, previous, pixels = zlib.decompress(compressed), width * 4, bytearray(width * 4), bytearray()
    if len(raw) != height * (stride + 1):
        raise ValueError(f"Unexpected PNG pixel length: {path}")
    for y in range(height):
        row_offset = y * (stride + 1)
        kind = raw[row_offset]
        row = bytearray(raw[row_offset + 1:row_offset + stride + 1])
        for x in range(stride):
            left = row[x - 4] if x >= 4 else 0
            up = previous[x]
            diagonal = previous[x - 4] if x >= 4 else 0
            if kind == 0:
                predicted = 0
            elif kind == 1:
                predicted = left
            elif kind == 2:
                predicted = up
            elif kind == 3:
                predicted = (left + up) // 2
            elif kind == 4:
                estimate = left + up - diagonal
                distances = (abs(estimate - left), abs(estimate - up), abs(estimate - diagonal))
                predicted = (left, up, diagonal)[distances.index(min(distances))]
            else:
                raise ValueError(f"Unknown PNG filter {kind}: {path}")
            row[x] = (row[x] + predicted) & 255
        pixels.extend(row)
        previous = row
    return width, height, bytes(pixels)


def alpha_bounds(width, height, pixels):
    visible = [(x, y) for y in range(height) for x in range(width) if pixels[(y * width + x) * 4 + 3]]
    if not visible:
        raise ValueError("Empty icon")
    return {
        "bounds": [min(x for x, _ in visible), min(y for _, y in visible), max(x for x, _ in visible) + 1, max(y for _, y in visible) + 1],
        "max_radius_ratio": max(math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) / width for x, y in visible),
    }


def android_vector(svg, *, padded=False):
    viewport = "40" if padded else "24"
    translate = ' android:translateX="8" android:translateY="8"' if padded else ""
    colour = "#FF006EFF" if padded else "#FFFFFFFF"
    lines = [f'<vector xmlns:android="{ANDROID_NS}" android:width="{108 if padded else 24}dp" android:height="{108 if padded else 24}dp" android:viewportWidth="{viewport}" android:viewportHeight="{viewport}">', f'  <group{translate}>']
    for item in svg:
        tag = item.tag.rsplit("}", 1)[-1]
        if tag == "circle":
            cx, cy, radius = (float(item.attrib[name]) for name in ("cx", "cy", "r"))
            geometry = f"M{cx-radius:g},{cy:g}a{radius:g},{radius:g} 0 1,0 {2*radius:g},0a{radius:g},{radius:g} 0 1,0 {-2*radius:g},0"
        elif tag == "path":
            geometry = item.attrib["d"]
        else:
            raise ValueError(f"Unsupported canonical SVG element: {tag}")
        lines.append(f'    <path android:fillColor="#00000000" android:strokeColor="{colour}" android:strokeWidth="{svg.attrib["stroke-width"]}" android:strokeLineCap="round" android:strokeLineJoin="round" android:pathData="{geometry}"/>')
    lines.extend(["  </group>", "</vector>", ""])
    return "\n".join(lines)


def copy_tree(source, destination):
    for path in sorted(source.rglob("*")):
        if path.is_file():
            target = destination / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)


def generate(command, evidence):
    source_bytes = CANONICAL.read_bytes()
    svg = ET.fromstring(source_bytes)
    if svg.attrib.get("viewBox") != "0 0 24 24" or svg.attrib.get("stroke") != "#006eff" or svg.attrib.get("fill") != "none":
        raise ValueError("Canonical brand must retain its 24x24 blue outline geometry")
    original_paths = {path.relative_to(ICONS).as_posix() for path in ICONS.rglob("*") if path.is_file()}
    with tempfile.TemporaryDirectory(prefix="easytier-brand-icons-") as temporary:
        work = Path(temporary)
        normal, android, inactive = (work / name for name in ("normal", "android", "inactive"))
        padded = work / "android-safe.svg"
        padded.write_text(source_bytes.decode().replace('viewBox="0 0 24 24"', 'viewBox="-8 -8 40 40"'))
        grey = work / "inactive.svg"
        grey.write_text(source_bytes.decode().replace('#006eff', '#6b7280'))
        for source, output in ((CANONICAL, normal), (padded, android), (grey, inactive)):
            subprocess.run([*command, "icon", str(source), "--output", str(output)], cwd=ROOT, check=True)
        regenerated_paths = {path.relative_to(normal).as_posix() for path in normal.rglob("*") if path.is_file()}
        regenerated_paths.update({"icon-inactive.ico", "icon.rgba"})
        stale_paths = original_paths - regenerated_paths
        if stale_paths:
            raise ValueError(f"Existing icon paths have no canonical replacement: {sorted(stale_paths)}")
        copy_tree(normal, ICONS)
        # Android's adaptive mask has a 66/108 dp safe circle. The same geometry
        # uses a 40x40 viewBox so every foreground pixel fits that circle.
        copy_tree(android / "android", ICONS / "android")
        copy_tree(ICONS / "android", ANDROID_RES)
        shutil.copyfile(inactive / "icon.ico", ICONS / "icon-inactive.ico")
        width, height, pixels = rgba_png(ICONS / "icon.png")
        (ICONS / "icon.rgba").write_bytes(pixels)
    for name in ("ic_launcher", "ic_launcher_round"):
        path = ANDROID_RES / "mipmap-anydpi-v26" / f"{name}.xml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'<adaptive-icon xmlns:android="{ANDROID_NS}">\n  <background android:drawable="@drawable/ic_launcher_background"/>\n  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n')
        path = ANDROID_RES / "mipmap-anydpi-v33" / f"{name}.xml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'<adaptive-icon xmlns:android="{ANDROID_NS}">\n  <background android:drawable="@drawable/ic_launcher_background"/>\n  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n  <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n</adaptive-icon>\n')
    (ANDROID_RES / "drawable/ic_launcher_background.xml").write_text(f'<shape xmlns:android="{ANDROID_NS}" android:shape="rectangle">\n  <solid android:color="#FFFFFFFF"/>\n</shape>\n')
    # Replace the unused Android Studio robot template too: it must not become
    # an old fallback when another Android packaging tool selects this resource.
    (ANDROID_RES / "drawable-v24/ic_launcher_foreground.xml").write_text(android_vector(svg, padded=True))
    (ANDROID_RES / "drawable/ic_launcher_monochrome.xml").write_text(android_vector(svg, padded=True).replace("#FF006EFF", "#FFFFFFFF"))
    (PLUGIN_DRAWABLE / "vpn_tile_icon.xml").write_text(android_vector(svg))
    brand = CANONICAL.parent
    web_copies = {
        brand / "favicon.ico": ICONS / "icon.ico",
        brand / "apple-touch-icon.png": ICONS / "ios/AppIcon-60x60@3x.png",
    }
    for directory in (ROOT / "easytier-web/frontend/public", ROOT / "easytier-gui/public"):
        web_copies.update({
            directory / "favicon.svg": CANONICAL,
            directory / "favicon.ico": ICONS / "icon.ico",
            directory / "apple-touch-icon.png": ICONS / "ios/AppIcon-60x60@3x.png",
            directory / "easytier.png": ICONS / "icon.png",
        })
    for destination, source in web_copies.items():
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        if sha256(destination) != sha256(source):
            raise ValueError(f"Browser icon copy mismatch: {destination}")
    files = sorted([*ICONS.rglob("*"), *ANDROID_RES.glob("mipmap-*/*"), *ANDROID_RES.glob("drawable*/ic_launcher*.xml"), PLUGIN_DRAWABLE / "vpn_tile_icon.xml"])
    pngs, android_proof = {}, {}
    for path in files:
        if path.suffix == ".png":
            pixel_width, pixel_height, rgba = rgba_png(path)
            relative = path.relative_to(ROOT).as_posix()
            pngs[relative] = {"width": pixel_width, "height": pixel_height}
            if path.name == "ic_launcher_foreground.png":
                android_proof[relative] = alpha_bounds(pixel_width, pixel_height, rgba)
                if android_proof[relative]["max_radius_ratio"] > 33 / 108:
                    raise ValueError(f"Android foreground exceeds safe circle: {path}")
    if len(pixels) != width * height * 4 or (width, height) != (512, 512):
        raise ValueError("Native RGBA icon dimensions changed unexpectedly")
    proof = {
        "status": "PASS",
        "canonical": {"path": CANONICAL.relative_to(ROOT).as_posix(), "sha256": sha256(CANONICAL), "view_box": svg.attrib["viewBox"], "stroke": svg.attrib["stroke"], "stroke_width": svg.attrib["stroke-width"]},
        "renderer": subprocess.run([*command, "--version"], cwd=ROOT, check=True, text=True, capture_output=True).stdout.strip(),
        "raw_rgba": {"path": (ICONS / "icon.rgba").relative_to(ROOT).as_posix(), "width": width, "height": height, "bytes": len(pixels), "matches_decoded_png": (ICONS / "icon.rgba").read_bytes() == pixels},
        "inactive_colour": "#6b7280",
        "android_foreground_safe_radius_ratio": 33 / 108,
        "android_foregrounds": android_proof,
        "png_dimensions": pngs,
        "files": {path.relative_to(ROOT).as_posix(): {"bytes": path.stat().st_size, "sha256": sha256(path)} for path in files if path.is_file()},
        "browser_files": {path.relative_to(ROOT).as_posix(): {"sha256": sha256(path), "source": source.relative_to(ROOT).as_posix()} for path, source in web_copies.items()},
    }
    if evidence:
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps({"status": proof["status"], "canonical_sha256": proof["canonical"]["sha256"], "generated_files": len(proof["files"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tauri-command", help="Tauri CLI command, for example 'pnpm --dir easytier-gui exec tauri'")
    parser.add_argument("--evidence", type=Path, help="Write a generated icon/hash manifest outside the source tree")
    options = parser.parse_args()
    generate(shlex.split(options.tauri_command) if options.tauri_command else ["pnpm", "--dir", str(ROOT / "easytier-gui"), "exec", "tauri"], options.evidence)
