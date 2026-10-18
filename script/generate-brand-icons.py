#!/usr/bin/env python3
"""Derive native and browser icons from assets/brand/easytier.svg using Tauri."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
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


def brand_geometry(svg):
    """Validate the source's circles, exact reflection and circle-centre links."""
    if svg.attrib.get("preserveAspectRatio") != "xMidYMid meet":
        raise ValueError("Canonical SVG must declare uniform centred scaling")
    if float(svg.attrib["width"]) != float(svg.attrib["height"]):
        raise ValueError("Canonical SVG intrinsic dimensions must remain square")
    circles, links = [], []
    for item in svg:
        tag = item.tag.rsplit("}", 1)[-1]
        if tag == "circle":
            if set(item.attrib) != {"cx", "cy", "r"}:
                raise ValueError("Canonical circles cannot override stroke or add transforms")
            circles.append(tuple(float(item.attrib[key]) for key in ("cx", "cy", "r")))
        elif tag == "path":
            if set(item.attrib) != {"d"}:
                raise ValueError("Canonical links cannot override stroke or add transforms")
            # This brand intentionally uses only explicit straight segments.
            tokens = re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?", item.attrib["d"])
            i, point = 0, None
            while i < len(tokens):
                command = tokens[i]
                i += 1
                if command in ("M", "L"):
                    end = (float(tokens[i]), float(tokens[i + 1]))
                    i += 2
                elif command == "H" and point is not None:
                    end = (float(tokens[i]), point[1])
                    i += 1
                else:
                    raise ValueError("Canonical links must use absolute M/L/H segments")
                if command != "M":
                    links.append((point, end))
                point = end
        else:
            raise ValueError(f"Unsupported brand element: {tag}")
    rounded = lambda point: tuple(round(value, 6) for value in point)
    if len(circles) != 3 or len(links) != 3 or len({r for _, _, r in circles}) != 1:
        raise ValueError("Brand must contain three equally sized circular nodes and links")
    if {rounded((24 - x, y, r)) for x, y, r in circles} != {rounded(circle) for circle in circles}:
        raise ValueError("Node geometry is not exactly horizontally mirrored")
    normalized = lambda edges: {tuple(sorted((rounded(a), rounded(b)))) for a, b in edges}
    mirrored = [((24 - a[0], a[1]), (24 - b[0], b[1])) for a, b in links]
    if normalized(links) != normalized(mirrored):
        raise ValueError("Link geometry is not exactly horizontally mirrored")
    maximum_contact_error = 0
    for begin, end in links:
        first = min(circles, key=lambda c: math.dist(begin, c[:2]))
        second = min(circles, key=lambda c: math.dist(end, c[:2]))
        if first == second:
            raise ValueError("A link must connect two different nodes")
        direction = (second[0] - first[0], second[1] - first[1])
        for point, circle in ((begin, first), (end, second)):
            offset = (point[0] - circle[0], point[1] - circle[1])
            collinear_error = abs(offset[0] * direction[1] - offset[1] * direction[0]) / math.hypot(*direction)
            contact_error = abs(math.dist(point, circle[:2]) - circle[2])
            maximum_contact_error = max(maximum_contact_error, collinear_error, contact_error)
    if maximum_contact_error > 0.000001:
        raise ValueError("A link is not aligned with its node centres and ring boundary")
    stroke = float(svg.attrib["stroke-width"])
    bounds = [min(x-r-stroke/2 for x, _, r in circles), min(y-r-stroke/2 for _, y, r in circles),
              max(x+r+stroke/2 for x, _, r in circles), max(y+r+stroke/2 for _, y, r in circles)]
    if abs(bounds[0] + bounds[2] - 24) > 0.000001 or abs(bounds[1] + bounds[3] - 24) > 0.000001:
        raise ValueError("Brand symbol bounding box is not centred in its square viewport")
    distances = [math.dist(a[:2], b[:2]) for i, a in enumerate(circles) for b in circles[i + 1:]]
    if max(distances) - min(distances) > 0.000001:
        raise ValueError("Node centres must form an equilateral network triangle")
    return {"horizontal_reflection_exact": True, "circular_nodes": len(circles),
            "equal_circle_radius": circles[0][2], "circle_axis_ratio": 1,
            "node_centre_distances": distances,
            "links": len(links), "maximum_contact_error_svg_units": maximum_contact_error,
            "symbol_bounds": bounds, "uniform_scale": True}


def raster_geometry(width, height, pixels):
    """Measure renderer rounding without rewriting or mirroring any bitmap."""
    if width != height:
        raise ValueError("Brand exports must remain square with uniform scaling")
    maximum, total, changed = 0, 0, 0
    for y in range(height):
        for x in range(width // 2):
            a, b = (y * width + x) * 4, (y * width + width - x - 1) * 4
            delta = max(abs(pixels[a + c] - pixels[b + c]) for c in range(4))
            maximum = max(maximum, delta)
            total += sum(abs(pixels[a + c] - pixels[b + c]) for c in range(4))
            changed += delta > 0
    comparisons = height * (width // 2)
    mean = total / (comparisons * 4)
    # tiny-skia's curve coverage is quantized. Geometry is exact; a two-byte
    # average (under 0.8%) is accepted, rather than editing exported pixels.
    if mean > 2:
        raise ValueError("Raster mirror difference exceeds antialiasing tolerance")
    bounds = alpha_bounds(width, height, pixels)["bounds"]
    if abs(bounds[0] + bounds[2] - width) > 1:
        raise ValueError("Raster symbol is horizontally off-centre")
    # Alpha alone covers the entire opaque iOS icon. Measure blue ink too so
    # those exports still demonstrate the symbol's original aspect ratio.
    ink = [(x, y) for y in range(height) for x in range(width)
           if pixels[(y * width + x) * 4 + 3] and pixels[(y * width + x) * 4 + 2] - pixels[(y * width + x) * 4] >= 32
           and pixels[(y * width + x) * 4 + 2] - pixels[(y * width + x) * 4 + 1] >= 16]
    ink_bounds = [min(x for x, _ in ink), min(y for _, y in ink), max(x for x, _ in ink) + 1, max(y for _, y in ink) + 1]
    return {"canvas_axis_ratio": width / height, "alpha_bounds": bounds, "symbol_ink_bounds": ink_bounds,
            "symbol_bbox_axis_ratio": (ink_bounds[2] - ink_bounds[0]) / (ink_bounds[3] - ink_bounds[1]),
            "mirror_max_channel_delta_255": maximum, "mirror_mean_channel_delta_255": mean,
            "mirror_differing_pair_fraction": changed / comparisons,
            "mirror_mean_tolerance_255": 2, "pixels_postprocessed": False}


def native_container_dimensions(path):
    """Validate native container frame sizes without executing native code."""
    data, frames = path.read_bytes(), []
    if path.suffix == ".ico":
        reserved, kind, count = struct.unpack_from("<HHH", data)
        if (reserved, kind) != (0, 1) or count == 0:
            raise ValueError("Invalid Windows icon container")
        for i in range(count):
            w, h, _, _, _, depth, length, offset = struct.unpack_from("<BBBBHHII", data, 6 + i * 16)
            w, h = w or 256, h or 256
            if w != h or offset + length > len(data):
                raise ValueError("Invalid or stretched Windows icon frame")
            frames.append({"width": w, "height": h, "depth": depth})
    else:
        if data[:4] != b"icns" or struct.unpack_from(">I", data, 4)[0] != len(data):
            raise ValueError("Invalid macOS icon container")
        offset = 8
        while offset < len(data):
            kind, length = data[offset:offset + 4].decode(), struct.unpack_from(">I", data, offset + 4)[0]
            if length < 8 or offset + length > len(data):
                raise ValueError("Invalid macOS icon frame")
            payload = data[offset + 8:offset + length]
            if payload.startswith(b"\x89PNG\r\n\x1a\n"):
                w, h = struct.unpack_from(">II", payload, 16)
                if w != h:
                    raise ValueError("Stretched macOS icon frame")
                frames.append({"type": kind, "width": w, "height": h})
            offset += length
        if not frames:
            raise ValueError("macOS icon has no PNG representations")
    return frames


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


def generate(command, evidence, preview_directory=None):
    source_bytes = CANONICAL.read_bytes()
    svg = ET.fromstring(source_bytes)
    if svg.attrib.get("viewBox") != "0 0 24 24" or svg.attrib.get("stroke") != "#006eff" or svg.attrib.get("fill") != "none":
        raise ValueError("Canonical brand must retain its 24x24 blue outline geometry")
    geometry = brand_geometry(svg)
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
    preview_proof = {}
    if preview_directory:
        preview_directory.mkdir(parents=True, exist_ok=True)
        sizes = (16, 24, 32, 64, 128, 256)
        arguments = [argument for size in sizes for argument in ("--png", str(size))]
        subprocess.run([*command, "icon", str(CANONICAL), "--output", str(preview_directory), *arguments], cwd=ROOT, check=True)
        for size in sizes:
            path = preview_directory / f"{size}x{size}.png"
            w, h, rgba = rgba_png(path)
            preview_proof[str(size)] = {"width": w, "height": h, **raster_geometry(w, h, rgba), "sha256": sha256(path)}
    files = sorted([*ICONS.rglob("*"), *ANDROID_RES.glob("mipmap-*/*"), *ANDROID_RES.glob("drawable*/ic_launcher*.xml"), PLUGIN_DRAWABLE / "vpn_tile_icon.xml"])
    pngs, android_proof = {}, {}
    for path in files:
        if path.suffix == ".png":
            pixel_width, pixel_height, rgba = rgba_png(path)
            relative = path.relative_to(ROOT).as_posix()
            pngs[relative] = {"width": pixel_width, "height": pixel_height, **raster_geometry(pixel_width, pixel_height, rgba)}
            if path.name == "ic_launcher_foreground.png":
                android_proof[relative] = alpha_bounds(pixel_width, pixel_height, rgba)
                if android_proof[relative]["max_radius_ratio"] > 33 / 108:
                    raise ValueError(f"Android foreground exceeds safe circle: {path}")
    if len(pixels) != width * height * 4 or (width, height) != (512, 512):
        raise ValueError("Native RGBA icon dimensions changed unexpectedly")
    proof = {
        "status": "PASS",
        "canonical": {"path": CANONICAL.relative_to(ROOT).as_posix(), "sha256": sha256(CANONICAL), "view_box": svg.attrib["viewBox"], "stroke": svg.attrib["stroke"], "stroke_width": svg.attrib["stroke-width"]},
        "geometry": geometry,
        "preview_rasters": preview_proof,
        "native_containers": {name: native_container_dimensions(ICONS / name)
                              for name in ("icon.ico", "icon-inactive.ico", "icon.icns")},
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
    parser.add_argument("--preview-dir", type=Path, help="Export 16/24/32/64/128/256 PNGs from the same SVG outside the source tree")
    options = parser.parse_args()
    generate(shlex.split(options.tauri_command) if options.tauri_command else ["pnpm", "--dir", str(ROOT / "easytier-gui"), "exec", "tauri"], options.evidence, options.preview_dir)
