'use strict';
// ══════════════════════════════════════════════════
// SHAPE BUILDER
// ══════════════════════════════════════════════════

const blockRot = id => int(id, 0, 0, 3);
const sorted2 = (a, b) => a <= b ? [a, b] : [b, a];

/** Read a block ID input; throws a readable error for IDs the game does not have. */
function blockId(inputId) {
  const id = int(inputId, BLOCK.ROAD);
  if (!isValidBlockId(id)) throw new Error(`Block ID ${id} does not exist in PolyTrack (valid: 0-${MAX_BLOCK_ID}, except ${[...INVALID_BLOCK_IDS].join(', ')}).`);
  return id;
}

// Blocks cover CS × CS units horizontally and are 1 unit tall, so shapes step by CS along X / Z
// and by 1 along Y. Ranges start at `min` and never go past `max`.
const stepsXZ = (min, max) => Array.from({ length: Math.floor((max - min) / CS) + 1 }, (_, i) => min + i * CS);
const stepsY = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => min + i);

/** Read a "min corner / max corner" pair of X·Y·Z inputs as lists of block positions per axis. */
function readBox(prefix) {
  return {
    xs: stepsXZ(...sorted2(int(prefix + 'MinX'), int(prefix + 'MaxX'))),
    ys: stepsY(...sorted2(int(prefix + 'MinY'), int(prefix + 'MaxY'))),
    zs: stepsXZ(...sorted2(int(prefix + 'MinZ'), int(prefix + 'MaxZ'))),
  };
}

/** Blocks from a to b: an edge-connected path in XZ with height interpolated, or a vertical column. */
function shapeLine(a, b) {
  if (Math.abs(b[0] - a[0]) < CS / 2 && Math.abs(b[2] - a[2]) < CS / 2) {
    return stepsY(...sorted2(a[1], b[1])).map(y => ({ x: a[0], y, z: a[2] }));
  }
  const cells = gridLine(a[0], a[2], b[0], b[2]);
  return cells.map((c, i) => ({ x: c.x, y: Math.round(a[1] + (b[1] - a[1]) * i / (cells.length - 1)), z: c.z }));
}

/** Describe the currently selected shape form: { label, estimate, build() → lines }. */
function buildShapeFromForm() {
  const type = $('shapeType').value;

  if (type === 'line') {
    const id = blockId('lineId'), rot = blockRot('lineRot');
    const a = [int('lsx'), int('lsy'), int('lsz')], b = [int('lex'), int('ley'), int('lez')];
    const estimate = (Math.abs(b[0] - a[0]) + Math.abs(b[2] - a[2])) / CS + Math.abs(b[1] - a[1]) + 1;
    return { label: 'Line', estimate, build: () => [{ id, rot, points: shapeLine(a, b) }] };
  }

  if (type === 'filledRect') {
    const plane = $('rectPlane').value, fixed = int('fixedCoord');
    const r1 = sorted2(int('rectMin1'), int('rectMax1')), r2 = sorted2(int('rectMin2'), int('rectMax2'));
    const id = blockId('rectId'), rot = blockRot('rectRot');
    // axis 1 / axis 2 per plane: xz → X,Z · xy → X,Y · yz → Y,Z
    const s1 = plane === 'yz' ? stepsY(...r1) : stepsXZ(...r1);
    const s2 = plane === 'xy' ? stepsY(...r2) : stepsXZ(...r2);
    return {
      label: `Filled rectangle (${plane.toUpperCase()})`, estimate: s1.length * s2.length,
      build: () => {
        const points = [];
        for (const u of s1) for (const v of s2) {
          points.push(plane === 'xz' ? { x: u, y: fixed, z: v } : plane === 'xy' ? { x: u, y: v, z: fixed } : { x: fixed, y: u, z: v });
        }
        return [{ id, rot, points }];
      },
    };
  }

  const hollow = type === 'hollowCube';
  const { xs, ys, zs } = readBox(hollow ? 'hc' : 'fc');
  const id = blockId(hollow ? 'hcId' : 'fcId'), rot = blockRot(hollow ? 'hcRot' : 'fcRot');
  const X = xs.length, Y = ys.length, Z = zs.length;
  const inner = Math.max(0, X - 2) * Math.max(0, Y - 2) * Math.max(0, Z - 2);
  return {
    label: hollow ? 'Hollow cube' : 'Filled cube', estimate: X * Y * Z - (hollow ? inner : 0),
    build: () => {
      const points = [];
      xs.forEach((x, i) => ys.forEach((y, j) => zs.forEach((z, k) => {
        const onShell = i === 0 || i === X - 1 || j === 0 || j === Y - 1 || k === 0 || k === Z - 1;
        if (!hollow || onShell) points.push({ x, y, z });
      })));
      return [{ id, rot, points }];
    },
  };
}

function addShape() {
  let shape;
  try { shape = buildShapeFromForm(); } catch (e) { reportError(e); return; }
  if (shape.estimate > LARGE_SHAPE_BLOCKS &&
      !confirm(`This shape is about ${shape.estimate.toLocaleString()} blocks and may be slow or too large to import. Add it anyway?`)) {
    return;
  }
  state.shapes.push({ label: shape.label, lines: shape.build() });
  refreshShapeUI();
  toast('Shape added');
}

function removeShape(i) { state.shapes.splice(i, 1); refreshShapeUI(); }

function clearShapes() {
  if (!state.shapes.length) return;
  state.shapes = [];
  refreshShapeUI();
  toast('Cleared');
}

const allShapeLines = () => state.shapes.flatMap(s => s.lines);
const blockCount = lines => lines.reduce((n, l) => n + l.points.length, 0);

function shapeSummary(shape) {
  const ids = [...new Set(shape.lines.map(l => l.id))].sort((a, b) => a - b);
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity, mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
  for (const l of shape.lines) for (const p of l.points) {
    mnX = Math.min(mnX, p.x); mnY = Math.min(mnY, p.y); mnZ = Math.min(mnZ, p.z);
    mxX = Math.max(mxX, p.x); mxY = Math.max(mxY, p.y); mxZ = Math.max(mxZ, p.z);
  }
  return { ids, blocks: blockCount(shape.lines), from: `(${mnX},${mnY},${mnZ})`, to: `(${mxX},${mxY},${mxZ})` };
}

function refreshShapeUI() {
  const lines = allShapeLines();
  if (state.mode === 'shape') {
    setStat('A', state.shapes.length);
    setStat('B', blockCount(lines).toLocaleString());
    setStat('C', new Set(lines.map(l => l.id)).size);
  }

  const list = $('linesList');
  if (!state.shapes.length) {
    list.innerHTML = '<div class="empty-st"><div>◈</div><p>No shapes yet.<br>Add shapes above to build your track.</p></div>';
    return;
  }
  list.replaceChildren(...state.shapes.map((shape, i) => {
    const s = shapeSummary(shape);
    const row = document.createElement('div');
    row.className = 'li';
    const names = s.ids.map(id => ID_NAMES[id]).filter(Boolean);
    row.innerHTML = `
      <div class="id-badge">ID&nbsp;${s.ids.length > 3 ? `${s.ids[0]}–${s.ids[s.ids.length - 1]}` : s.ids.join('·')}</div>
      <div class="li-info">
        <div class="li-name"></div>
        <div class="li-meta">${s.blocks.toLocaleString()} block${s.blocks !== 1 ? 's' : ''}</div>
        <div class="li-coords">${s.from} → ${s.to}</div>
      </div>
      <button type="button" class="btn btn-del btn-sm" title="Remove shape" aria-label="Remove shape">✕</button>`;
    row.querySelector('.li-name').textContent = shape.label + (names.length === 1 ? ` · ${names[0]}` : '');
    row.querySelector('button').addEventListener('click', () => removeShape(i));
    return row;
  }));
}

async function generateShape() {
  const lines = allShapeLines();
  if (!lines.length) { toast('Add at least one shape first'); return; }
  log('Compressing…', 'warn');
  dbg('=== Shape Generate ===');
  try {
    emitCode(await encodeTrack(lines, text('shapeTrackName', 'My Track'), text('shapeAuthor', 'Builder')), lines);
    refreshShapeUI();
    toast('Track generated!');
  } catch (e) {
    reportError(e);
  }
}

function generateTestTrack() {
  const [mn, mx] = sorted2(int('minId', 1, 0, MAX_BLOCK_ID), int('maxId', 50, 0, MAX_BLOCK_ID));
  const lines = [{ id: BLOCK.START, rot: 0, points: [{ x: 0, y: 0, z: 0 }] }];
  let pos = 0;
  for (let id = mn; id <= mx; id++) {
    if (!isValidBlockId(id)) continue;
    pos += 20;
    lines.push({ id, rot: 0, points: [{ x: pos, y: 0, z: 0 }] });
  }
  lines.push({ id: BLOCK.FINISH, rot: 0, points: [{ x: pos + 20, y: 0, z: 0 }] });
  state.shapes = [{ label: `ID test track ${mn}–${mx}`, lines }];
  refreshShapeUI();
  toast(`ID test track: IDs ${mn}-${mx}`);
}

function exportJSON() {
  if (!state.shapes.length) { toast('No shapes to export'); return; }
  downloadBlob(JSON.stringify(state.shapes, null, 2), 'application/json', 'shapes.json');
}

function syncRectLabels() {
  const LABELS = {
    xz: ['Fixed Y', 'Min X', 'Max X', 'Min Z', 'Max Z'],
    xy: ['Fixed Z', 'Min X', 'Max X', 'Min Y', 'Max Y'],
    yz: ['Fixed X', 'Min Y', 'Max Y', 'Min Z', 'Max Z'],
  };
  const [fixed, min1, max1, min2, max2] = LABELS[$('rectPlane').value];
  $('fixedLabel').textContent = fixed;
  $('min1Label').textContent = min1; $('max1Label').textContent = max1;
  $('min2Label').textContent = min2; $('max2Label').textContent = max2;
}

function initShapes() {
  $('shapeType').addEventListener('change', () => {
    const type = $('shapeType').value;
    document.querySelectorAll('.sf').forEach(f => { f.hidden = f.id !== 'form-' + type; });
    if (type === 'filledRect') syncRectLabels();
  });
  $('rectPlane').addEventListener('change', syncRectLabels);
  refreshShapeUI();
}
