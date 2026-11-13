'use strict';
// ══════════════════════════════════════════════════
// KML MODE - real-world path → 1:1 circuit
// ══════════════════════════════════════════════════

/** Simplification tolerance (metres) applied to the KML path before building. */
const RDP_TOLERANCE_M = 10;
const ELEVATION_API = 'https://api.open-elevation.com/api/v1/lookup';
const ELEVATION_BATCH = 256;
/** Elevation is sampled at least this often along the path (2 ramp lengths). */
const ELEVATION_SAMPLE_M = 160;

/** Parse a KML document and return the longest <coordinates> list as [{lon, lat, alt}]. */
function parseKML(txt) {
  txt = txt.replace(/^﻿/, '').replace(/<\?xml[^>]*\?>\s*/i, '');
  const doc = new DOMParser().parseFromString(txt, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Could not parse KML - make sure you pasted the complete file.');
  }
  // A KML file may contain several placemarks (e.g. a pin plus the path) - use the longest one
  let best = [];
  for (const el of doc.getElementsByTagName('coordinates')) {
    const coords = [];
    for (const pt of el.textContent.trim().split(/\s+/)) {
      const p = pt.split(',').map(Number);
      if (p.length >= 2 && !p.some(Number.isNaN)) coords.push({ lon: p[0], lat: p[1], alt: p[2] || 0 });
    }
    if (coords.length > best.length) best = coords;
  }
  if (!best.length) throw new Error('No <coordinates> found - paste a valid KML path file.');
  if (best.length < 2) throw new Error('KML must contain at least 2 coordinate points.');
  return best;
}

/**
 * Convert local-metre path points into PolyTrack block lines.
 *
 * Geometry (from a decoded hill track):
 *   1 Y unit = 5 real metres
 *   ID145 = transition ramp: 8 coord units long, no surface Y change, stored y = surface_y
 *   ID146 = slope ramp:      8 coord units long, ±4 surface Y,        stored y = surface_y ± 2
 *   One ramp MODULE = ID145 + ID146 = 16 coord units long, ±4 Y (= 20 m rise)
 */
function kmlPathToLines(local, { ox, oy, oz, roadWidth: rw, turnAngle, useElevation }) {
  // Quantize altitude to multiples of 4 Y (= 20 m) so ramp modules fit exactly
  const altToY = alt => Math.round(alt / 20) * 4;

  const snapped = local.map(p => ({
    bx: (Math.round(p.x / 20) + ox) * CS,
    bz: (oz - Math.round(p.z / 20)) * CS,   // north = -Z, so the track is not mirrored in the game
    by: useElevation ? altToY(p.alt) : oy * CS,
  }));

  // Drop consecutive points that snap to the same XZ cell (keep the latest Y)
  const pts = [{ ...snapped[0] }];
  for (let i = 1; i < snapped.length; i++) {
    const prev = pts[pts.length - 1];
    if (snapped[i].bx !== prev.bx || snapped[i].bz !== prev.bz) pts.push({ ...snapped[i] });
    else prev.by = snapped[i].by;
  }

  // ── Collectors ───────────────────────────────────
  const flatSeen = new Set(), flatRoad = [];
  const rampSeen = new Set(), rampBlocks = [];
  const halfW = Math.floor(rw / 2);

  function pushFlat(p) {
    const k = `${p.x},${p.y},${p.z}`;
    if (!flatSeen.has(k)) { flatSeen.add(k); flatRoad.push({ x: p.x, y: p.y, z: p.z }); }
  }
  /** Road slab centred on (x,y,z); widenX = spread across X (travel along Z). */
  function addFlatSlab(x, y, z, widenX) {
    for (let w = 0; w < rw; w++) {
      const off = (w - halfW) * CS;
      pushFlat({ x: x + (widenX ? off : 0), y, z: z + (widenX ? 0 : off) });
    }
  }
  // Ordered centre-line cells of the road (null = ramp), used to find straight spots for gates
  const centrePath = [];
  function addCentre(x, y, z, widenX) {
    const prev = centrePath[centrePath.length - 1];
    if (!prev || prev.x !== x || prev.y !== y || prev.z !== z) centrePath.push({ x, y, z });
    addFlatSlab(x, y, z, widenX);
  }
  /** Flat road along a (possibly diagonal) line at height y. */
  function addFlatLine(x1, z1, x2, z2, y) {
    const widenX = Math.abs(x2 - x1) < Math.abs(z2 - z1);
    const cells = gridLine(x1, z1, x2, z2);
    cells.forEach((c, i) => {
      addCentre(c.x, y, c.z, widenX);
      // Diagonals are staircases: where the stair turns, also fill the opposite corner of that
      // 2×2 square, so the straight driving line has road on both sides instead of a bare edge
      const p = cells[i - 1], n = cells[i + 1];
      if (p && n && p.x !== n.x && p.z !== n.z) addFlatSlab(p.x + n.x - c.x, y, p.z + n.z - c.z, widenX);
    });
  }
  function addRamp(id, rot, x, y, z, cardinal) {
    const travelZ = cardinal === 0 || cardinal === 2;
    for (let w = 0; w < rw; w++) {
      const off = (w - halfW) * CS;
      const wx = x + (travelZ ? off : 0), wz = z + (travelZ ? 0 : off);
      const k = `${id},${rot},${wx},${y},${wz}`;
      if (!rampSeen.has(k)) { rampSeen.add(k); rampBlocks.push({ id, rot, x: wx, y, z: wz }); }
    }
  }

  // surface_y is the height the car drives on; carried between segments
  let surfaceY = pts[0].by;

  // ── Segment walker ───────────────────────────────
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ddx = b.bx - a.bx, ddz = b.bz - a.bz;
    const cardinal = snapCardinal(ddx, ddz);
    const dir = CARDINALS[cardinal];

    const travelZ = cardinal === 0 || cardinal === 2;
    let nRamps = 0, ascending = false;
    if (useElevation) {
      const hSpan = Math.abs(travelZ ? ddz : ddx);
      const dY = b.by - surfaceY;                      // multiple of 4
      ascending = dY > 0;
      // A ramp is 16 units long; keep one block (CS) free so the cell at b stays a flat block
      nRamps = Math.max(0, Math.min(Math.abs(dY) / 4, Math.floor((hSpan - CS) / 16)));
    }

    if (nRamps === 0) {
      // No elevation change possible here - straight (or diagonal-staircased) flat road
      addFlatLine(a.bx, a.bz, b.bx, b.bz, surfaceY);
      continue;
    }

    // Ramp parts are anchored 4 units into their 8-unit footprint (checked against the game's part table)
    const rampLen = nRamps * 16;
    if (ascending) {
      // a: flat block, then ramps straight along the travel axis, then flat road (incl. any sideways drift) to b
      addCentre(a.bx, surfaceY, a.bz, travelZ);
      centrePath.push(null);
      let cx = a.bx, cz = a.bz;
      for (let r = 0; r < nRamps; r++) {
        addRamp(BLOCK.RAMP_TRANSITION, dir.asc145, cx + dir.dx * 4,  surfaceY,     cz + dir.dz * 4,  cardinal);
        addRamp(BLOCK.RAMP_SLOPE,      dir.asc146, cx + dir.dx * 12, surfaceY + 2, cz + dir.dz * 12, cardinal);
        cx += dir.dx * 16; cz += dir.dz * 16;
        surfaceY += 4;
      }
      addFlatLine(cx + dir.dx * CS, cz + dir.dz * CS, b.bx, b.bz, surfaceY);
    } else {
      // flat road (incl. any sideways drift) from a to the top of the ramps, then ramps straight down into b
      const topX = b.bx - dir.dx * rampLen, topZ = b.bz - dir.dz * rampLen;
      addFlatLine(a.bx, a.bz, topX - dir.dx * CS, topZ - dir.dz * CS, surfaceY);
      centrePath.push(null);
      let cx = topX, cz = topZ;
      for (let r = 0; r < nRamps; r++) {
        addRamp(BLOCK.RAMP_SLOPE,      dir.dsc146, cx + dir.dx * 4,  surfaceY - 2, cz + dir.dz * 4,  cardinal);
        addRamp(BLOCK.RAMP_TRANSITION, dir.dsc145, cx + dir.dx * 12, surfaceY - 4, cz + dir.dz * 12, cardinal);
        cx += dir.dx * 16; cz += dir.dz * 16;
        surfaceY -= 4;
      }
      // the block at b itself is laid by the next segment (or becomes the finish)
    }
  }

  // ── Checkpoints at corners ───────────────────────
  // Detected from the full-resolution local path so tight corners that snap to the same cell
  // aren't missed. Each checkpoint is placed on an actual flat road block (the one at the corner,
  // or the nearest one) so it never floats above / sinks into a ramp.
  // A gate (checkpoint / finish) has posts, so it must sit where the car drives straight through it:
  // a centre-line cell whose neighbours on both sides continue in the same direction at the same height.
  const stepDir = (p, q) => (p && q && p.y === q.y && Math.abs(q.x - p.x) + Math.abs(q.z - p.z) === CS)
    ? snapCardinal(q.x - p.x, q.z - p.z) : -1;
  const straightAt = j => {
    const d = stepDir(centrePath[j - 1], centrePath[j]);
    return d >= 0 && d === stepDir(centrePath[j], centrePath[j + 1]) ? d : -1;
  };
  const GATE_SEARCH = 8;   // cells to look before / after a corner for a straight spot

  const cps = [], cpSeen = new Set();
  let pathIdx = 1;          // checkpoints are placed in driving order; never on the start cell
  for (let i = 1; i < local.length - 1; i++) {
    const prev = local[i - 1], cur = local[i], next = local[i + 1];
    if (angleBetween(cur.x - prev.x, cur.z - prev.z, next.x - cur.x, next.z - cur.z) < turnAngle) continue;
    const sx = (Math.round(cur.x / 20) + ox) * CS;
    const sz = (oz - Math.round(cur.z / 20)) * CS;
    // locate the corner on the centre line, at or after the previous checkpoint
    let corner = -1, best = Infinity;
    for (let j = pathIdx; j < centrePath.length - 1; j++) {
      const c = centrePath[j];
      if (!c) continue;
      const d = (c.x - sx) ** 2 + (c.z - sz) ** 2;
      if (d < best) { best = d; corner = j; }
      if (d === 0) break;
    }
    if (corner < 0) continue;
    // prefer a straight cell just before the corner, then just after it, then the corner itself
    let at = -1, cardinal = -1;
    for (let k = 1; k <= GATE_SEARCH && at < 0; k++) {
      const j = corner - k;
      if (j >= pathIdx && (cardinal = straightAt(j)) >= 0) at = j;
    }
    // (after a corner, leave a cell of room so cars have straightened up before the gate)
    for (let k = 2; k <= GATE_SEARCH && at < 0; k++) {
      const j = corner + k;
      if (j < centrePath.length - 1 && (cardinal = straightAt(j)) >= 0) at = j;
    }
    if (at < 0) {
      at = corner;
      cardinal = Math.max(0, stepDir(centrePath[corner - 1], centrePath[corner]));
    }
    const c = centrePath[at];
    const key = `${c.x},${c.z}`;
    if (!cpSeen.has(key)) { cpSeen.add(key); cps.push({ bx: c.x, by: c.y, bz: c.z, cardinal }); }
    pathIdx = Math.max(pathIdx, at + 1);
  }

  // ── Normalize so the lowest block sits at y = 0 ──
  let minY = Infinity;
  for (const b of flatRoad) minY = Math.min(minY, b.y);
  for (const b of rampBlocks) minY = Math.min(minY, b.y);
  for (const c of cps) minY = Math.min(minY, c.by);
  for (const p of pts) minY = Math.min(minY, p.by);
  minY = Math.min(minY, surfaceY);
  let yShift = 0;
  if (minY < 0) {
    const shift = yShift = -minY;
    for (const b of flatRoad) b.y += shift;
    for (const b of rampBlocks) b.y += shift;
    for (const c of cps) c.by += shift;
    for (const p of pts) p.by += shift;
    surfaceY += shift;
  }

  // ── Assemble output ──────────────────────────────
  // Start, finish and checkpoints REPLACE the road block at their position (parts must not overlap).
  // Finish and checkpoint parts are gates with posts, so they are rotated to face the direction of
  // travel, and on wide roads one gate is placed per lane so they cannot be driven around.
  const key3 = (x, y, z) => `${x},${y},${z}`;
  const isRoad = (x, y, z) => flatSeen.has(key3(x, y - yShift, z));
  const taken = new Set();
  /** Cells across the road at (x,y,z) for travel direction `cardinal`; null if any lane is missing. */
  const across = (x, y, z, cardinal) => {
    const travelZ = cardinal === 0 || cardinal === 2, cells = [];
    for (let w = 0; w < rw; w++) {
      const off = (w - halfW) * CS;
      const c = { x: x + (travelZ ? off : 0), y, z: z + (travelZ ? 0 : off) };
      if (off !== 0 && !isRoad(c.x, c.y, c.z)) return null;
      cells.push(c);
    }
    return cells;
  };
  const claim = cells => cells.filter(c => {
    const k = key3(c.x, c.y, c.z);
    if (taken.has(k)) return false;
    taken.add(k); return true;
  });

  const first = pts[0], last = pts[pts.length - 1];
  const segCardinal = i => snapCardinal(pts[i + 1].bx - pts[i].bx, pts[i + 1].bz - pts[i].bz);
  // Face the start along the first road step and the finish gate along the last one
  const pathCells = centrePath.filter(Boolean);
  const firstStep = stepDir(pathCells[0], pathCells[1]), lastStep = stepDir(pathCells[pathCells.length - 2], pathCells[pathCells.length - 1]);
  const startRot = firstStep >= 0 ? firstStep : pts.length > 1 ? segCardinal(0) : 0;
  const finishRot = lastStep >= 0 ? lastStep : pts.length > 1 ? segCardinal(pts.length - 2) : 0;
  const startCells = claim([{ x: first.bx, y: first.by, z: first.bz }]);
  // Closed loops end where they began: put the finish on the last road block before the start
  let fin = { x: last.bx, y: surfaceY, z: last.bz };
  if (taken.has(key3(fin.x, fin.y, fin.z))) {
    for (let i = flatRoad.length - 1; i >= 0; i--) {
      if (!taken.has(key3(flatRoad[i].x, flatRoad[i].y, flatRoad[i].z))) { fin = flatRoad[i]; break; }
    }
  }
  const finishCells = claim(across(fin.x, fin.y, fin.z, finishRot) || [fin]);
  const cpLines = [];
  for (const cp of cps) {
    const cells = claim(across(cp.bx, cp.by, cp.bz, cp.cardinal) || [{ x: cp.bx, y: cp.by, z: cp.bz }]);
    if (!cells.length) continue;   // corner coincides with start / finish
    const idx = cpLines.length;
    cpLines.push({ id: BLOCK.CHECKPOINT, rot: cp.cardinal, cpIndex: idx, points: cells.map(c => ({ ...c, cpIndex: idx })) });
  }
  const road = flatRoad.filter(b => !taken.has(key3(b.x, b.y, b.z)));

  const lines = [];
  if (road.length) lines.push({ id: BLOCK.ROAD, rot: 0, points: road });
  for (const rb of rampBlocks) lines.push({ id: rb.id, rot: rb.rot, points: [{ x: rb.x, y: rb.y, z: rb.z }] });
  lines.push(...cpLines);
  lines.push({ id: BLOCK.START, rot: startRot, points: startCells });
  lines.push({ id: BLOCK.FINISH, rot: finishRot, points: finishCells });
  const placedCps = cpLines.map(l => ({ bx: l.points[0].x, by: l.points[0].y, bz: l.points[0].z }));

  return { lines, blockPts: pts, cps: placedCps, roadBlocks: flatRoad.length + rampBlocks.length, useElevation };
}

// ── Preview canvas ─────────────────────────────────
function redrawKML() {
  if (state.mode !== 'kml') return;
  const r = state.lastKML;
  drawKMLCanvas(r?.blockPts, r?.cps, r?.useElevation);
}

function drawKMLCanvas(blockPts, cps = [], useElev = false) {
  const canvas = $('kmlCanvas');
  const { ctx, W, H } = fitCanvas(canvas, 310);
  const dark = isDarkTheme();
  const accent = cssVar('--accent') || '#2563eb';
  const start = cssVar('--success') || '#16a34a';
  const finish = cssVar('--danger') || '#dc2626';
  const cpColor = cssVar('--cyan') || '#22d3ee';
  const mono = '"JetBrains Mono", ui-monospace, monospace';

  ctx.fillStyle = cssVar('--panel') || (dark ? '#111827' : '#ffffff');
  ctx.fillRect(0, 0, W, H);
  if (!blockPts || blockPts.length < 2) { $('cvInfo').textContent = 'NO TRACK LOADED'; return; }

  const [mnX, mxX] = minMax(blockPts.map(p => p.bx));
  const [mnZ, mxZ] = minMax(blockPts.map(p => p.bz));
  const pad = 42, rX = mxX - mnX || 1, rZ = mxZ - mnZ || 1;
  const sc = Math.min((W - pad * 2) / rX, (H - pad * 2) / rZ);
  // Centre the drawing in the canvas; north (-Z) points up, as in the game's own track thumbnails
  const offX = (W - rX * sc) / 2, offY = (H - rZ * sc) / 2;
  const toC = (bx, bz) => ({ cx: offX + (bx - mnX) * sc, cy: offY + (bz - mnZ) * sc });

  // Dot grid
  ctx.fillStyle = dark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.06)';
  const gs = Math.max(1, Math.round(38 / sc));
  for (let gx = 0; gx <= rX; gx += gs) for (let gz = 0; gz <= rZ; gz += gs) {
    const { cx, cy } = toC(mnX + gx, mnZ + gz);
    ctx.fillRect(cx, cy, 1, 1);
  }

  const [mnY, mxY] = minMax(blockPts.map(p => p.by));
  const rY = mxY - mnY;
  const showElev = useElev && rY > 0;

  // Track - coloured by elevation (blue = low → red = high) or plain accent
  ctx.lineWidth = Math.max(1.5, sc * .65);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (showElev) {
    for (let i = 0; i < blockPts.length - 1; i++) {
      const t = (blockPts[i].by - mnY) / rY;
      ctx.strokeStyle = `hsl(${(1 - t) * 240},90%,55%)`;
      ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 4;
      const p1 = toC(blockPts[i].bx, blockPts[i].bz), p2 = toC(blockPts[i + 1].bx, blockPts[i + 1].bz);
      ctx.beginPath(); ctx.moveTo(p1.cx, p1.cy); ctx.lineTo(p2.cx, p2.cy); ctx.stroke();
    }
  } else {
    ctx.shadowColor = accent; ctx.shadowBlur = 5; ctx.strokeStyle = accent;
    ctx.beginPath();
    blockPts.forEach((p, i) => { const { cx, cy } = toC(p.bx, p.bz); i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // Checkpoints
  ctx.fillStyle = cpColor;
  for (const cp of cps) { const { cx, cy } = toC(cp.bx, cp.bz); ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill(); }

  // Start / finish
  const s = toC(blockPts[0].bx, blockPts[0].bz);
  const f = toC(blockPts[blockPts.length - 1].bx, blockPts[blockPts.length - 1].bz);
  ctx.shadowBlur = 10;
  for (const [p, c] of [[s, start], [f, finish]]) {
    ctx.shadowColor = c; ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(p.cx, p.cy, 5.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.font = `10px ${mono}`;
  ctx.fillStyle = start; ctx.fillText('START', s.cx + 8, s.cy + 3);
  ctx.fillStyle = finish; ctx.fillText('FINISH', f.cx + 8, f.cy + 3);

  // Legend
  if (showElev) {
    const lx = pad + 4, ly = H - 18, lw = 80;
    for (let px = 0; px < lw; px++) { ctx.fillStyle = `hsl(${(1 - px / lw) * 240},90%,55%)`; ctx.fillRect(lx + px, ly, 1, 8); }
    ctx.font = `8px ${mono}`;
    ctx.fillStyle = dark ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.45)';
    // by is in Y units (5 m each); values are relative to the lowest point after normalization
    ctx.fillText(`${Math.round(mnY * 5)}m`, lx, ly - 2);
    ctx.fillText(`${Math.round(mxY * 5)}m`, lx + lw - 20, ly - 2);
  } else {
    ctx.fillStyle = cpColor; ctx.beginPath(); ctx.arc(pad + 4, H - 17, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = dark ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.4)';
    ctx.font = `10px ${mono}`;
    ctx.fillText('CHECKPOINT', pad + 11, H - 13);
  }

  const bw = Math.round(rX / CS), bh = Math.round(rZ / CS);
  $('cvInfo').textContent = `${bw}×${bh} blocks · ${(bw * 20 / 1000).toFixed(1)}×${(bh * 20 / 1000).toFixed(1)} km`;
}

function refreshKMLStats() {
  const s = state.lastKML?.stats;
  if (!s) return;
  setStat('A', s.points, 'KML Points');
  setStat('B', s.roadBlocks.toLocaleString(), 'Road Blocks');
  setStat('C', s.checkpoints, 'Checkpoints');
  setStat('D', s.dValue, s.dLabel);
}

// ── Elevation lookup ───────────────────────────────
/** Insert interpolated points so consecutive coordinates are at most maxM metres apart. */
function densify(coords, maxM) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const n = Math.ceil(haversineM(a.lon, a.lat, b.lon, b.lat) / maxM);
    for (let k = 1; k < n; k++) out.push({ lon: a.lon + (b.lon - a.lon) * k / n, lat: a.lat + (b.lat - a.lat) * k / n, alt: 0 });
    out.push(b);
  }
  return out;
}

/** Replace .alt on each {lat, lon} with real terrain altitude (metres) from open-elevation.com. */
async function fetchElevation(coords, onProgress) {
  const out = [...coords];
  const batches = Math.ceil(coords.length / ELEVATION_BATCH);
  for (let i = 0; i < coords.length; i += ELEVATION_BATCH) {
    const chunk = coords.slice(i, i + ELEVATION_BATCH);
    let data;
    try {
      const resp = await fetch(ELEVATION_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ locations: chunk.map(c => ({ latitude: c.lat, longitude: c.lon })) }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
    } catch (e) {
      throw new Error(`open-elevation API failed: ${e.message}. Check your internet connection and try again.`);
    }
    const results = data?.results;
    if (!Array.isArray(results) || results.length !== chunk.length) {
      throw new Error(`open-elevation returned unexpected data (got ${results?.length}, expected ${chunk.length})`);
    }
    chunk.forEach((c, j) => { out[i + j] = { ...c, alt: Number(results[j].elevation) || 0 }; });
    onProgress?.(Math.min(i + ELEVATION_BATCH, coords.length), coords.length);
    dbg(`Elevation batch ${i / ELEVATION_BATCH + 1}/${batches}: ${chunk.length} pts fetched`, 'ok');
  }
  return out;
}

// ── Generate ───────────────────────────────────────
async function generateKML() {
  const btn = $('kmlBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Working…';
  try {
    const txt = $('kmlInput').value.trim();
    if (!txt) { log('Paste or load a KML file first.', 'err'); toast('Paste or load a KML file first'); return; }
    dbg('=== KML Generate ===');
    log('Parsing KML…', 'warn');

    const coords = parseKML(txt);
    let dist = 0;
    for (let i = 1; i < coords.length; i++) dist += haversineM(coords[i - 1].lon, coords[i - 1].lat, coords[i].lon, coords[i].lat);

    // Smooth with RDP once; keep indices so elevation can be fetched for the kept lon/lat points
    const kept = rdpIndices(toLocal(coords), RDP_TOLERANCE_M);
    let smoothed = kept.map(i => coords[i]);
    dbg(`RDP: ${coords.length}→${smoothed.length} pts (tol=${RDP_TOLERANCE_M}m)`, 'warn');

    const useElevation = $('useElevation').checked;
    let dLabel = 'Circuit Length', dValue = (dist / 1000).toFixed(2) + ' km';
    if (useElevation) {
      // RDP only looks at the map outline, so re-insert points along long straights -
      // otherwise hills and dips between two corners would be lost
      smoothed = densify(smoothed, ELEVATION_SAMPLE_M);
      btn.textContent = `⏳ Fetching elevation (0/${smoothed.length})…`;
      log(`Fetching elevation for ${smoothed.length} pts…`, 'warn');
      smoothed = await fetchElevation(smoothed, (done, total) => {
        btn.textContent = `⏳ Elevation ${done}/${total}…`;
        log(`Elevation: ${done}/${total}…`, 'warn');
      });
      const [lo, hi] = minMax(smoothed.map(c => c.alt));
      dbg(`Elevation range: ${lo.toFixed(1)}m - ${hi.toFixed(1)}m (${Math.round(hi - lo)}m)`, 'ok');
      dLabel = 'Elev Range'; dValue = Math.round(hi - lo) + 'm';
    }

    btn.textContent = '⏳ Building track…';
    const result = kmlPathToLines(toLocal(smoothed), {
      ox: int('originX', 0),
      oy: int('originY', 0),
      oz: int('originZ', 0),
      roadWidth: int('roadWidth', 1, 1, 10),
      turnAngle: clamp(num('turnAngle', 30), 5, 90),
      useElevation,
    });
    result.stats = { points: coords.length, roadBlocks: result.roadBlocks, checkpoints: result.cps.length, dLabel, dValue };
    state.lastKML = result;
    refreshKMLStats();
    drawKMLCanvas(result.blockPts, result.cps, result.useElevation);

    log('Compressing…', 'warn');
    const code = await encodeTrack(result.lines, text('kmlTrackName', 'My Circuit'), text('kmlAuthor', 'Builder'));
    emitCode(code, result.lines);
    toast('Circuit generated!');
  } catch (e) {
    reportError(e);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ── File loading ───────────────────────────────────
function loadKMLFile(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    $('kmlInput').value = ev.target.result;
    log('File loaded: ' + file.name, 'ok');
    toast('Loaded ' + file.name);
  };
  reader.onerror = () => reportError(new Error('Could not read ' + file.name));
  reader.readAsText(file);
}

function initKML() {
  $('useElevation').addEventListener('change', e => { $('elevNote').hidden = !e.target.checked; });

  const zone = $('dropZone'), input = $('fileInput');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer.files[0]) loadKMLFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => {
    if (input.files[0]) loadKMLFile(input.files[0]);
    input.value = ''; // allow re-selecting the same file
  });
}
