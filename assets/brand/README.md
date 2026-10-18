# EasyTier mark

`easytier.svg` is the single source for the application, browser, installer,
notification tile and adaptive launcher icons. Its three circular nodes and
blue `#006eff` outline match the interface. The SVG has a square 24 × 24 viewport
and explicitly requests uniform centred scaling.

The upper node centres are `(5.5, 6.370835)` and `(18.5, 6.370835)`;
the lower centre is `(12, 17.629165)`. All rings have radius `2.25` and stroke
width `1.5`. Their centres form an equilateral triangle, rounded to six decimal
places. Every connector follows the line between two circle centres and ends
on the ring's centre line. The nodes, connectors and symbol bounding box are
exactly reflected about `x = 12`. The symbol bounding box is centred vertically
and horizontally; circles are never stretched into ellipses.

Regenerate all existing native and browser resources from that SVG:

```sh
python3 script/generate-brand-icons.py \
  --evidence /tmp/easytier-brand/proof.json \
  --preview-dir /tmp/easytier-brand/previews
node script/preview-brand-icons.mjs /tmp/easytier-brand/previews
```

These commands export assets; they do not compile the application. The existing
locked Tauri icon exporter supplies Windows ICO, macOS ICNS, PNG, iOS and Android
densities. The raw RGBA icon is decoded from the generated native PNG. The
inactive ICO is a grey colour variant of the same SVG geometry. Android vector
and monochrome resources are derived from the same circle/path elements.

Android uses the unchanged 40 × 40 padded viewport. Every foreground density
must fit inside the guaranteed 66 / 108 dp adaptive safe circle. The launcher
background is opaque white. Preview masks are synthetic illustrations, not
screenshots from a device; the Android preview reduces the highest-density
foreground instead of enlarging a low-density bitmap.

The generator rejects unequal circles, a non-mirrored source, off-axis links,
non-square exports and unsafe adaptive foregrounds. Its evidence records each
export's dimensions, ink bounding box, hash and horizontal pixel mirror
max/mean difference. SVG geometry is strictly mirrored. The icon exporter's
quantized antialiasing can produce small raster differences, particularly at
16 px; the mean channel difference must remain below 2 / 255 (0.8%). Exported
pixels are never patched, stretched or mirrored after rendering.

The preview contact sheet shows 16, 24, 32, 64, 128 and 256 px at their actual
pixel sizes on both light and dark backgrounds. `platforms.png` shows Windows,
macOS and adaptive launcher masks with the same mark.
