'use strict';
// ══════════════════════════════════════════════════
// PIXEL ART (3 shades)
// ══════════════════════════════════════════════════

const BIN_COLORS = ['#1a2eaa', '#7a7e96', '#d8ddf0']; // dark / mid / light display colours
const PREVIEW_SIZE = 270;

/** Downsample an image and bucket each pixel into 3 luminance bins (terciles). */
function quantizeImage(img, res, keepAspect) {
  let tw, th;
  if (keepAspect) {
    if (img.width >= img.height) { tw = res; th = Math.round(img.height * (res / img.width)); }
    else { th = res; tw = Math.round(img.width * (res / img.height)); }
  } else {
    tw = th = res;
  }
  tw = clamp(tw, 2, 256); th = clamp(th, 2, 256);

  const off = document.createElement('canvas');
  off.width = tw; off.height = th;
  const oc = off.getContext('2d');
  oc.imageSmoothingEnabled = true;
  oc.drawImage(img, 0, 0, tw, th);
  const { data } = oc.getImageData(0, 0, tw, th);

  // Luminance, compositing transparent pixels over white
  const lum = new Float32Array(tw * th);
  for (let i = 0; i < tw * th; i++) {
    const al = data[i * 4 + 3] / 255;
    const r = data[i * 4] * al + 255 * (1 - al);
    const g = data[i * 4 + 1] * al + 255 * (1 - al);
    const b = data[i * 4 + 2] * al + 255 * (1 - al);
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const sorted = Float32Array.from(lum).sort();
  const t1 = sorted[Math.floor(sorted.length / 3)];
  const t2 = sorted[Math.floor(2 * sorted.length / 3)];
  const pixels = [];
  for (let y = 0; y < th; y++) {
    const row = [];
    for (let x = 0; x < tw; x++) { const l = lum[y * tw + x]; row.push(l < t1 ? 0 : l < t2 ? 1 : 2); }
    pixels.push(row);
  }
  return { w: tw, h: th, pixels };
}

function processUpload() {
  const file = $('imgUpload').files[0];
  if (!file) { toast('Choose an image file first'); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    state.pixels = quantizeImage(img, int('resValue', 64, 8, 256), $('preserveAspect').checked);
    const { w, h } = state.pixels;
    $('pixPanel').hidden = state.mode !== 'pixel';
    $('pixCount').textContent = (w * h).toLocaleString();
    $('pixW').textContent = w;
    $('pixH').textContent = h;
    refreshPixelStats();
    drawPixelPreview();
    toast(`Preview: ${w}×${h} pixels, 3 shades`);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    reportError(new Error(`Could not load "${file.name}" as an image`));
  };
  img.src = url;
}

function refreshPixelStats() {
  if (state.mode !== 'pixel' || !state.pixels) return;
  const { w, h } = state.pixels;
  setStat('A', (w * h).toLocaleString());
  setStat('B', w);
  setStat('C', h);
}

function drawPixelPreview() {
  const cvs = $('previewCanvas');
  const ctx = cvs.getContext('2d');
  const S = PREVIEW_SIZE;
  if (!state.pixels) { ctx.clearRect(0, 0, S, S); return; }
  const { w, h, pixels } = state.pixels;
  const scale = Math.min(S / w, S / h);
  const pw = Math.floor(scale * w), ph = Math.floor(scale * h);
  ctx.fillStyle = cssVar('--card') || (isDarkTheme() ? '#1e293b' : '#f8fafc');
  ctx.fillRect(0, 0, S, S);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      ctx.fillStyle = BIN_COLORS[pixels[y][x]];
      ctx.fillRect(Math.round(x * scale + (S - pw) / 2), Math.round(y * scale + (S - ph) / 2), Math.ceil(scale), Math.ceil(scale));
    }
  }
}

function buildPixelLines() {
  if (!state.pixels) return [];
  const spacing = int('pixelSpacing', 1, 1, 10);
  const bs = $('use4x').checked ? CS : 1;
  const ox = int('offsetX'), oy = int('offsetY'), oz = int('offsetZ');
  const ids = [int('idBin0', 5, 0, 255), int('idBin1', 25, 0, 255), int('idBin2', 52, 0, 255)];
  const { w, h, pixels } = state.pixels;
  const lines = [];
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const id = ids[pixels[py][px]];
    const mx = ox + px * spacing * bs, mz = oz + py * spacing * bs;
    for (let z = mz; z < mz + bs; z++) lines.push({ id, rot: 0, points: line3D(mx, oy, z, mx + (bs - 1), oy, z) });
  }
  return lines;
}

async function generatePixel() {
  if (!state.pixels) { toast('Preview an image first (Step 1)'); return; }
  const lines = buildPixelLines();
  if (!lines.length) { toast('No pixel data to generate'); return; }
  log('Compressing…', 'warn');
  dbg('=== Pixel Generate ===');
  try {
    emitCode(await encodeTrack(lines, text('pixelTrackName', 'Pixel Art'), text('pixelAuthor', 'Builder')));
    refreshPixelStats();
    toast('Pixel art track generated!');
  } catch (e) {
    reportError(e);
  }
}
