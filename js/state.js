'use strict';
// ══════════════════════════════════════════════════
// SHARED CONSTANTS, STATE & DOM HELPERS
// ══════════════════════════════════════════════════

/** PolyTrack coordinate units per block (1 block = 20 m, so 1 unit = 5 m). */
const CS = 4;

/**
 * Block (part) IDs used by the generators. Names are the game's own (PolyTrack 0.6.3).
 * Footprints, from the game's part table: flat "Plane" parts cover 4×4 units (1 unit tall), so
 * neighbouring blocks must be CS = 4 units apart. The two "long slope" parts cover 4×8 units and
 * each rise 2 units; a 145 + 146 pair forms one smooth ramp rising 4 units over 16.
 */
const BLOCK = {
  ROAD: 25,              // Plane
  CHECKPOINT: 75,        // PlaneCheckpoint
  FINISH: 76,            // PlaneFinish
  START: 92,             // PlaneStart - rotation r faces CARDINALS[r]
  RAMP_TRANSITION: 145,  // PlaneSlopeUpLong   (lower half of a ramp: flat → incline)
  RAMP_SLOPE: 146,       // PlaneSlopeDownLong (upper half of a ramp: incline → flat), placed 2 units higher
};

const ID_NAMES = {
  5: 'Start (track piece)', 6: 'Finish (track piece)',
  25: 'Plane road', 52: 'Checkpoint (track piece)',
  75: 'Plane checkpoint', 76: 'Plane finish', 92: 'Plane start',
  145: 'Plane slope, lower half', 146: 'Plane slope, upper half',
};

/** Highest part ID the game knows, and the gaps below it (verified against the game's importer). */
const MAX_BLOCK_ID = 189;
const INVALID_BLOCK_IDS = new Set([60, 89]);
const isValidBlockId = id => Number.isInteger(id) && id >= 0 && id <= MAX_BLOCK_ID && !INVALID_BLOCK_IDS.has(id);

/**
 * Travel directions, indexed by "cardinal": 0 = -Z, 1 = -X, 2 = +Z, 3 = +X.
 * Ramp rotations confirmed from a 4-direction decode of an in-game track:
 *   ascending  ID145 rot = cardinal, ID146 rot = (cardinal + 2) % 4
 *   descending is the mirror (ID146 first, then ID145, rotations swapped).
 * `angle` is the compass angle used by the hill inserter (0° = +Z, 90° = +X).
 */
const CARDINALS = [
  { label: '-Z', angle: 180, dx: 0,  dz: -1, asc145: 0, asc146: 2, dsc146: 0, dsc145: 2 },
  { label: '-X', angle: 270, dx: -1, dz: 0,  asc145: 1, asc146: 3, dsc146: 1, dsc145: 3 },
  { label: '+Z', angle: 0,   dx: 0,  dz: 1,  asc145: 2, asc146: 0, dsc146: 2, dsc145: 0 },
  { label: '+X', angle: 90,  dx: 1,  dz: 0,  asc145: 3, asc146: 1, dsc146: 3, dsc145: 1 },
];

/** Ask for confirmation before building shapes larger than this many blocks. */
const LARGE_SHAPE_BLOCKS = 250000;

const state = {
  mode: 'kml',
  shapes: [],     // shape builder entries: { label, lines: [{id, rot, points}] }
  pixelSource: null, // downsampled upload: { w, h, data: RGBA }
  pixels: null,      // colour-matched image: { w, h, cells, env, palette, used }
  code: '',       // last generated track code
  lastKML: null,  // last KML build result + stats
};

const $ = id => document.getElementById(id);

/** Read a numeric input; falls back only when the field is empty / not a number (0 is kept). */
function num(id, fallback = 0) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
}

/** Read an integer input, clamped to [min, max]. */
function int(id, fallback = 0, min = -Infinity, max = Infinity) {
  return clamp(Math.round(num(id, fallback)), min, max);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function text(id, fallback) { return $(id).value.trim() || fallback; }

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function isDarkTheme() { return document.documentElement.getAttribute('data-theme') === 'dark'; }

/** Size a canvas to its CSS width at device pixel ratio; returns a context in CSS pixels. */
function fitCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 800;
  canvas.style.height = cssHeight + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W: w, H: cssHeight };
}

function downloadBlob(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Min / max without spreading into Math.min (which overflows the stack on large arrays). */
function minMax(values) {
  let mn = Infinity, mx = -Infinity;
  for (const v of values) { if (v < mn) mn = v; if (v > mx) mx = v; }
  return [mn, mx];
}
