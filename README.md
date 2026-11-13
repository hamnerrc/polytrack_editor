# PolyTrack Studio

A browser-based track builder that generates PolyTrack import codes. Open `index.html` in a browser — no build step or server required.

## Modes

- **KML Circuit** — convert a Google Earth path (KML) into a 1:1-scale circuit (1 block = 20 × 20 m), with optional real terrain elevation via open-elevation.com.
- **Shape Builder** — place lines, rectangles, cubes and hills block by block.
- **Pixel Art** — turn an image into a 3-shade block mosaic.

## Project layout

```
index.html        Page markup
css/styles.css    All styles (light/dark theme tokens at the top)
js/state.js       Shared constants (block IDs, ramp rotation table), app state, DOM helpers
js/ui.js          Theme, toast, status log, debug console, mode switching
js/geometry.js    3D Bresenham lines, haversine, RDP simplification, direction snapping
js/encoder.js     PolyTrack1 binary format + zlib/base-62 encoding, copy/download
js/kml.js         KML parsing, elevation lookup, road/ramp/checkpoint generation, preview canvas
js/shapes.js      Shape builder, ID test track, JSON export
js/hill.js        Hill inserter and its rotation diagram
js/pixel.js       Image quantization and pixel-art track generation
js/main.js        Startup wiring
```

Scripts are plain (non-module) scripts loaded in order, so the page also works when opened directly from `file://`.
