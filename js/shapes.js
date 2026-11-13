'use strict';
// ══════════════════════════════════════════════════
// SHAPE BUILDER
// ══════════════════════════════════════════════════

const blockId = id => int(id, 25, 0, 255);
const blockRot = id => int(id, 0, 0, 3);
const sorted2 = (a, b) => a <= b ? [a, b] : [b, a];

/** Read a "min corner / max corner" pair of X·Y·Z inputs, normalized so min <= max. */
function readBox(prefix) {
  const [mnX, mxX] = sorted2(int(prefix + 'MinX'), int(prefix + 'MaxX'));
  const [mnY, mxY] = sorted2(int(prefix + 'MinY'), int(prefix + 'MaxY'));
  const [mnZ, mxZ] = sorted2(int(prefix + 'MinZ'), int(prefix + 'MaxZ'));
  return { mnX, mxX, mnY, mxY, mnZ, mxZ };
}

/** Build the line list for the currently selected shape form. Returns { label, lines, estimate }. */
function buildShapeFromForm() {
  const type = $('shapeType').value;
  const lines = [];

  if (type === 'line') {
    const id = blockId('lineId'), rot = blockRot('lineRot');
    const a = [int('lsx'), int('lsy'), int('lsz')], b = [int('lex'), int('ley'), int('lez')];
    const estimate = Math.max(...a.map((v, i) => Math.abs(b[i] - v))) + 1;
    return { label: 'Line', estimate, build: () => [{ id, rot, points: line3D(...a, ...b) }] };
  }

  if (type === 'filledRect') {
    const plane = $('rectPlane').value, fixed = int('fixedCoord');
    const [mn1, mx1] = sorted2(int('rectMin1'), int('rectMax1'));
    const [mn2, mx2] = sorted2(int('rectMin2'), int('rectMax2'));
    const id = blockId('rectId'), rot = blockRot('rectRot');
    const estimate = (mx1 - mn1 + 1) * (mx2 - mn2 + 1);
    return {
      label: `Filled rectangle (${plane.toUpperCase()})`, estimate,
      build: () => {
        for (let v = mn2; v <= mx2; v++) {
          if (plane === 'xz') lines.push({ id, rot, points: line3D(mn1, fixed, v, mx1, fixed, v) });
          else if (plane === 'xy') lines.push({ id, rot, points: line3D(mn1, v, fixed, mx1, v, fixed) });
          else lines.push({ id, rot, points: line3D(fixed, mn1, v, fixed, mx1, v) });
        }
        return lines;
      },
    };
  }

  if (type === 'hollowCube') {
    const { mnX, mxX, mnY, mxY, mnZ, mxZ } = readBox('hc');
    const id = blockId('hcId'), rot = blockRot('hcRot');
    const X = mxX - mnX + 1, Y = mxY - mnY + 1, Z = mxZ - mnZ + 1;
    return {
      label: 'Hollow cube', estimate: 2 * (X * Z + X * Y + Y * Z),
      build: () => {
        for (let z = mnZ; z <= mxZ; z++) {           // floor + ceiling
          lines.push({ id, rot, points: line3D(mnX, mnY, z, mxX, mnY, z) });
          if (mxY !== mnY) lines.push({ id, rot, points: line3D(mnX, mxY, z, mxX, mxY, z) });
        }
        for (let y = mnY; y <= mxY; y++) {           // front + back walls
          lines.push({ id, rot, points: line3D(mnX, y, mnZ, mxX, y, mnZ) });
          if (mxZ !== mnZ) lines.push({ id, rot, points: line3D(mnX, y, mxZ, mxX, y, mxZ) });
        }
        for (let z = mnZ; z <= mxZ; z++) {           // left + right walls
          lines.push({ id, rot, points: line3D(mnX, mnY, z, mnX, mxY, z) });
          if (mxX !== mnX) lines.push({ id, rot, points: line3D(mxX, mnY, z, mxX, mxY, z) });
        }
        return lines;
      },
    };
  }

  // filledCube
  const { mnX, mxX, mnY, mxY, mnZ, mxZ } = readBox('fc');
  const id = blockId('fcId'), rot = blockRot('fcRot');
  return {
    label: 'Filled cube', estimate: (mxX - mnX + 1) * (mxY - mnY + 1) * (mxZ - mnZ + 1),
    build: () => {
      for (let y = mnY; y <= mxY; y++) for (let z = mnZ; z <= mxZ; z++) {
        lines.push({ id, rot, points: line3D(mnX, y, z, mxX, y, z) });
      }
      return lines;
    },
  };
}

function addShape() {
  const shape = buildShapeFromForm();
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
    emitCode(await encodeTrack(lines, text('shapeTrackName', 'My Track'), text('shapeAuthor', 'Builder')));
    refreshShapeUI();
    toast('Track generated!');
  } catch (e) {
    reportError(e);
  }
}

function generateTestTrack() {
  const [mn, mx] = sorted2(int('minId', 1, 0, 255), int('maxId', 50, 0, 255));
  const lines = [{ id: BLOCK.START, rot: 0, points: [{ x: 0, y: 0, z: 0 }] }];
  let pos = 0;
  for (let id = mn; id <= mx; id++) {
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
