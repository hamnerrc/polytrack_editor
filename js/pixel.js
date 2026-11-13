'use strict';
// ══════════════════════════════════════════════════
// PIXEL ART - full-colour, matched to the game's real block colours
// ══════════════════════════════════════════════════
//
// Two targets:
//  - "preview": the map preview the game shows on a track's page before you enter it. The game
//    draws that picture itself, one pixel per block, with exactly five colours (see PREVIEW_COLORS).
//  - "game": the 3D view while driving. PIXEL_PALETTE (js/pixel-palette.js) holds the colour every
//    flat block really has on screen, measured per environment, plus the colour of bare ground.
// Each image pixel is assigned the palette entry that looks closest (distance in the perceptual OKLab space), optionally with
// Floyd–Steinberg dithering so gradients and in-between colours are approximated by block patterns.

const PREVIEW_SIZE = 270;
const ENVIRONMENTS = ['Summer', 'Winter', 'Desert'];   // index = environment byte in the track code
const BLOCK_LABELS = { 29: 'Block', 25: 'Road', 75: 'Checkpoint', 76: 'Finish', 92: 'Start' };

/**
 * Colours of the game's map preview (taken from the game's own thumbnail drawing code, verified by
 * the tests): every block is drawn in one environment-dependent colour, except checkpoints, starts
 * and finishes; cells without a block show the dark panel behind the picture.
 */
const PREVIEW_COLORS = {
  background: [33, 43, 88],
  base: { Summer: [255, 255, 255], Winter: [190, 216, 247], Desert: [237, 226, 175] },
  checkpoint: [226, 192, 38],
  start: [51, 140, 224],
  finish: [209, 41, 41],
};
/**
 * With only ~16 colours available, a wrong hue (a purple band in a blue sky) looks far worse than a
 * slightly wrong brightness, so hue / saturation differences count more than lightness differences.
 */
const CHROMA_WEIGHT = 4;

// ── Colour maths ───────────────────────────────────
const srgbToLinear = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
function rgbToOklab([r, g, b]) {
  r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** Palette for a target + environment: [{ id, color, rgb, lab }]; id null = no block (empty cell). */
function pixelPalette(target, envName, useEmpty) {
  const entries = target === 'preview' ? [
    { id: null, color: 0, rgb: PREVIEW_COLORS.background },
    { id: BLOCK.ROAD, color: 0, rgb: PREVIEW_COLORS.base[envName] },
    { id: BLOCK.CHECKPOINT, color: 0, rgb: PREVIEW_COLORS.checkpoint },
    { id: BLOCK.START, color: 0, rgb: PREVIEW_COLORS.start },
    { id: BLOCK.FINISH, color: 0, rgb: PREVIEW_COLORS.finish },
  ] : PIXEL_PALETTE[envName];
  return entries
    .filter(p => useEmpty || p.id !== null)
    .map(p => ({ ...p, lab: rgbToOklab(p.rgb) }));
}

function nearest(palette, rgb) {
  const lab = rgbToOklab(rgb);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i].lab;
    const d = (p[0] - lab[0]) ** 2 + CHROMA_WEIGHT * ((p[1] - lab[1]) ** 2 + (p[2] - lab[2]) ** 2);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, dist: bestD };
}

/**
 * Map an RGBA image onto a palette.
 * Returns { cells: Int16Array (palette index, -1 = transparent → no block), error: mean OKLab distance }.
 */
function quantize(src, palette, dither) {
  const { w, h, data } = src;
  const buf = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) for (let k = 0; k < 3; k++) buf[i * 3 + k] = data[i * 4 + k];
  const cells = new Int16Array(w * h);
  let error = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (data[i * 4 + 3] < 128) { cells[i] = -1; continue; }
    const want = [0, 1, 2].map(k => clamp(buf[i * 3 + k], 0, 255));
    const { index, dist } = nearest(palette, want);
    cells[i] = index;
    error += Math.sqrt(dist); n++;
    if (!dither) continue;
    // Floyd–Steinberg: push the colour error onto the pixels still to come
    const got = palette[index].rgb;
    for (const [dx, dy, f] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= w || yy >= h) continue;
      for (let k = 0; k < 3; k++) buf[(yy * w + xx) * 3 + k] += (want[k] - got[k]) * f;
    }
  }
  return { cells, error: n ? error / n : 0 };
}

// ── Image loading ──────────────────────────────────
/** Downsample an image to at most `res` pixels on its longest side; returns { w, h, data: RGBA }. */
function downsample(img, res, keepAspect) {
  let tw = res, th = res;
  if (keepAspect) {
    if (img.width >= img.height) th = Math.round(img.height * (res / img.width));
    else tw = Math.round(img.width * (res / img.height));
  }
  tw = clamp(tw, 1, 256); th = clamp(th, 1, 256);
  const off = document.createElement('canvas');
  off.width = tw; off.height = th;
  const oc = off.getContext('2d', { willReadFrequently: true });
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(img, 0, 0, tw, th);
  return { w: tw, h: th, data: oc.getImageData(0, 0, tw, th).data };
}

function processUpload() {
  const file = $('imgUpload').files[0];
  if (!file) { toast('Choose an image file first'); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    state.pixelSource = downsample(img, int('resValue', 64, 4, 256), $('preserveAspect').checked);
    requantize();
    toast(`Preview: ${state.pixels.w}×${state.pixels.h} pixels, ${state.pixels.used.length} colours`);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    reportError(new Error(`Could not load "${file.name}" as an image`));
  };
  img.src = url;
}

/** Re-run colour matching for the loaded image with the current options. */
function requantize() {
  const src = state.pixelSource;
  if (!src) return;
  const useGround = $('pixelUseGround').checked, dither = $('pixelDither').checked;
  const choice = $('pixelEnv').value, target = $('pixelTarget').value;
  // "Auto" picks the environment whose colours (incl. its ground) reproduce the image best
  const candidates = (choice === 'auto' ? ENVIRONMENTS : [choice]).map(env => {
    const palette = pixelPalette(target, env, useGround);
    return { env, palette, score: quantize(src, palette, false).error };
  });
  const best = candidates.reduce((a, b) => b.score < a.score ? b : a);
  const { cells } = quantize(src, best.palette, dither);

  const counts = new Map();
  for (const c of cells) if (c >= 0) counts.set(c, (counts.get(c) || 0) + 1);
  state.pixels = {
    w: src.w, h: src.h, cells, env: best.env, palette: best.palette, target,
    background: target === 'preview' ? PREVIEW_COLORS.background : groundRgb(best.env),
    used: [...counts].sort((a, b) => b[1] - a[1]).map(([index, count]) => ({ ...best.palette[index], count })),
  };
  $('pixPanel').hidden = state.mode !== 'pixel';
  refreshPixelStats();
  drawPixelPreview();
  renderPixelLegend();
}

function refreshPixelStats() {
  if (state.mode !== 'pixel' || !state.pixels) return;
  const { w, h, cells, palette } = state.pixels;
  let blocks = 0;
  for (const c of cells) if (c >= 0 && palette[c].id !== null) blocks++;
  setStat('A', (w * h).toLocaleString());
  setStat('B', w);
  setStat('C', h);
  setStat('D', blocks.toLocaleString(), 'Blocks');
  $('pixCount').textContent = blocks.toLocaleString();
  $('pixW').textContent = w;
  $('pixH').textContent = h;
}

const groundRgb = env => PIXEL_PALETTE[env].find(p => p.id === null).rgb;
const cssRgb = rgb => `rgb(${rgb.join(',')})`;

/** Preview using the colours the blocks really have in the game (empty cells show the ground). */
function drawPixelPreview() {
  const cvs = $('previewCanvas');
  const ctx = cvs.getContext('2d');
  const S = PREVIEW_SIZE;
  if (!state.pixels) { ctx.clearRect(0, 0, S, S); return; }
  const { w, h, cells, palette, background } = state.pixels;
  const scale = Math.min(S / w, S / h);
  const x0 = (S - scale * w) / 2, y0 = (S - scale * h) / 2;
  ctx.fillStyle = cssRgb(background);
  ctx.fillRect(0, 0, S, S);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = cells[y * w + x];
    if (c < 0) continue;
    ctx.fillStyle = cssRgb(palette[c].rgb);
    ctx.fillRect(Math.floor(x0 + x * scale), Math.floor(y0 + y * scale), Math.ceil(scale), Math.ceil(scale));
  }
}

function renderPixelLegend() {
  const { used, env } = state.pixels;
  $('pixelEnvInfo').textContent = `Environment: ${env}` + ($('pixelEnv').value === 'auto' ? ' (best match)' : '');
  $('pixelLegend').replaceChildren(...used.map(p => {
    const row = document.createElement('div');
    row.className = 'map-row';
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = cssRgb(p.rgb);
    const label = document.createElement('span');
    label.textContent = p.id === null ? 'Empty (no block)'
      : `${BLOCK_LABELS[p.id]} · ID ${p.id}` + (p.color ? `, colour ${p.color}` : '');
    const count = document.createElement('span');
    count.className = 'legend-count';
    count.textContent = p.count.toLocaleString();
    row.append(sw, label, count);
    return row;
  }));
}

// ── Track generation ───────────────────────────────
/** One block per pixel (image x → +X, image y → +Z, i.e. upright when seen from above with north up). */
function buildPixelLines() {
  if (!state.pixels) return [];
  const spacing = int('pixelSpacing', 1, 1, 10) * CS;
  const ox = int('offsetX'), oy = int('offsetY'), oz = int('offsetZ');
  const { w, h, cells, palette, target } = state.pixels;
  const groups = new Map();
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const c = cells[py * w + px];
    if (c < 0 || palette[c].id === null) continue;   // transparent / ground-coloured: leave empty
    if (!groups.has(c)) groups.set(c, { id: palette[c].id, color: palette[c].color, rot: 0, points: [] });
    groups.get(c).points.push({ x: ox + px * spacing, y: oy, z: oz + py * spacing });
  }
  const lines = [...groups.values()];
  // For driving, the game needs a start block: park one just outside the picture's top-left corner.
  // (Not for the map preview - it would show up there as a stray blue pixel.)
  if (lines.length && target === 'game') lines.push({ id: BLOCK.START, rot: 0, points: [{ x: ox - 2 * CS, y: oy, z: oz - 2 * CS }] });
  return lines;
}

async function generatePixel() {
  if (!state.pixels) { toast('Preview an image first (Step 1)'); return; }
  const lines = buildPixelLines();
  if (!lines.length) { toast('Nothing to build - every pixel matches the empty background'); return; }
  log('Compressing…', 'warn');
  dbg(`=== Pixel Generate (${state.pixels.env}) ===`);
  try {
    const env = ENVIRONMENTS.indexOf(state.pixels.env);
    emitCode(await encodeTrack(lines, text('pixelTrackName', 'Pixel Art'), text('pixelAuthor', 'Builder'), env), lines);
    refreshPixelStats();
    toast('Pixel art track generated!');
  } catch (e) {
    reportError(e);
  }
}

function initPixel() {
  for (const id of ['pixelTarget', 'pixelEnv', 'pixelUseGround', 'pixelDither']) $(id).addEventListener('change', requantize);
}
