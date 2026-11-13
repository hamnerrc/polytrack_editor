'use strict';
// ══════════════════════════════════════════════════
// HILL INSERTER - verified from a 4-direction test track
// ══════════════════════════════════════════════════
//
// Layout along the travel direction, measured from the base block (the last flat road block
// before the hill). Checked against the real game's part footprints and by driving it:
//   base +4   y+0  ID145  ← lower half of the up-ramp   (covers +2 … +9)
//   base +12  y+2  ID146  ← upper half of the up-ramp   (covers +10 … +17), peak at y+4
//   base +24  y+2  ID146  ← upper half of the down-ramp (covers +18 … +25)
//   base +32  y+0  ID145  ← lower half of the down-ramp (covers +26 … +33)
//   base +36       flat road continues here
// Rotations per direction live in CARDINALS (state.js).
const HILL_LENGTH = 36;

/** Compass angle (0° = +Z, 90° = +X, 180° = -Z, 270° = -X) → cardinal index. */
function angleToCardinal(deg) {
  const norm = ((deg % 360) + 360) % 360;
  const snap = Math.round(norm / 90) % 4;
  return [2, 3, 0, 1][snap];
}

function syncHillAngle(val) {
  const v = clamp(Math.round(+val || 0), 0, 359);
  $('hillAngle').value = v;
  $('hillAngleTxt').value = v;
  updateHillPreview(v);
}

function updateHillPreview(deg) {
  const c = angleToCardinal(deg);
  const h = CARDINALS[c];
  $('hillRotInfo').innerHTML =
    `Snapped to <b>${h.label}</b> (${h.angle}°)<br>` +
    `Ascend: ID145 rot=<b>${h.asc145}</b> → ID146 rot=<b>${h.asc146}</b><br>` +
    `Descend: ID146 rot=<b>${h.dsc146}</b> → ID145 rot=<b>${h.dsc145}</b>`;
  drawHillDiagram(deg, c);
}

function drawHillDiagram(deg, cardinal) {
  const cvs = $('hillCanvas');
  const ctx = cvs.getContext('2d');
  const W = cvs.width, H = cvs.height;
  const dark = isDarkTheme();
  const acc = cssVar('--accent') || '#2563eb';
  const dim = cssVar('--muted') || '#94a3b8';
  const grn = cssVar('--success') || '#16a34a';
  const cyn = cssVar('--cyan') || '#0e7490';
  const line = cssVar('--border') || '#334155';
  const lineStrong = cssVar('--border-strong') || '#475569';
  const mono = '"JetBrains Mono", ui-monospace, monospace';
  const h = CARDINALS[cardinal];

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--card') || (dark ? '#1e293b' : '#f5f7fb');
  ctx.fillRect(0, 0, W, H);

  // ── Compass (top) ──────────────────────────
  const cx = W / 2, cy = 68, R = 52;
  ctx.strokeStyle = line; ctx.lineWidth = 1;
  for (let a = 0; a < 360; a += 45) {
    const r = (a - 90) * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(r) * R, cy + Math.sin(r) * R); ctx.stroke();
  }
  ctx.strokeStyle = lineStrong;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.font = `bold 8px ${mono}`;
  ctx.fillStyle = dim; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('+Z', cx, cy - 63); ctx.fillText('-Z', cx, cy + 63);
  ctx.fillText('+X', cx + 63, cy); ctx.fillText('-X', cx - 63, cy);

  // Dashed line = requested angle; solid arrow = snapped direction
  const norm = ((deg % 360) + 360) % 360, snapDeg = h.angle;
  const angDiff = Math.min(Math.abs(norm - snapDeg), 360 - Math.abs(norm - snapDeg));
  if (angDiff > 2) {
    const rr = (norm - 90) * Math.PI / 180;
    ctx.strokeStyle = dim; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(rr) * 44, cy + Math.sin(rr) * 44); ctx.stroke();
    ctx.setLineDash([]);
  }
  const sr = (snapDeg - 90) * Math.PI / 180;
  const ax = cx + Math.cos(sr) * 46, ay = cy + Math.sin(sr) * 46;
  ctx.shadowColor = acc; ctx.shadowBlur = 8;
  ctx.strokeStyle = acc; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ax, ay); ctx.stroke();
  const hl = 9, hr = Math.PI / 6;
  ctx.fillStyle = acc; ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - hl * Math.cos(sr - hr), ay - hl * Math.sin(sr - hr));
  ctx.lineTo(ax - hl * Math.cos(sr + hr), ay - hl * Math.sin(sr + hr));
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  // ── Cross-section profile (bottom) ─────────
  // Horizontal units: base block 2, four 8-unit ramp parts, 2 of the next road block = 36
  const bY = H - 16, bX = 10, bW = W - 20, sc = bW / 36, ys = 28 / 4;
  const profile = [[0, 0], [2, 0], [10, 1.2], [18, 4], [26, 1.2], [34, 0], [36, 0]];
  ctx.strokeStyle = dim; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bX, bY); ctx.lineTo(bX + bW, bY); ctx.stroke();

  ctx.fillStyle = dark ? 'rgba(96,165,250,.10)' : 'rgba(37,99,235,.08)';
  ctx.beginPath(); ctx.moveTo(bX, bY);
  for (const [u, y] of profile) ctx.lineTo(bX + u * sc, bY - y * ys);
  ctx.closePath(); ctx.fill();

  ctx.strokeStyle = acc; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(bX, bY);
  for (const [u, y] of profile) ctx.lineTo(bX + u * sc, bY - y * ys);
  ctx.stroke();

  ctx.strokeStyle = dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.1)';
  ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
  for (const u of [2, 10, 18, 26, 34]) { ctx.beginPath(); ctx.moveTo(bX + u * sc, bY); ctx.lineTo(bX + u * sc, bY - 50); ctx.stroke(); }
  ctx.setLineDash([]);

  ctx.font = `7px ${mono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const segs = [
    { mid: 6,  y: 0, label: ['145', `r=${h.asc145}`], col: grn },
    { mid: 14, y: 3, label: ['146', `r=${h.asc146}`], col: acc },
    { mid: 22, y: 3, label: ['146', `r=${h.dsc146}`], col: acc },
    { mid: 30, y: 0, label: ['145', `r=${h.dsc145}`], col: grn },
  ];
  for (const s of segs) {
    const lx = bX + s.mid * sc, ly = bY - s.y * ys - 22;
    ctx.fillStyle = s.col;
    s.label.forEach((ln, i) => ctx.fillText(ln, lx, ly + i * 9));
  }
  ctx.fillStyle = cyn; ctx.textAlign = 'left';
  ctx.fillText('y+4', bX + 18 * sc + 4, bY - 4 * ys - 6);
}

function addHill() {
  const deg = num('hillAngleTxt', 0);
  const bx = int('hillX'), by = int('hillY'), bz = int('hillZ');
  const width = int('hillWidth', 1, 1, 20);
  const h = CARDINALS[angleToCardinal(deg)];

  // Lanes spread perpendicular to travel direction, one block (CS units) apart
  const travelZ = h.dx === 0;
  const halfW = Math.floor(width / 2);
  const lines = [];
  for (let w = 0; w < width; w++) {
    const off = (w - halfW) * CS;
    const wx = bx + (travelZ ? off : 0), wz = bz + (travelZ ? 0 : off);
    const at = (d, dy) => [{ x: wx + h.dx * d, y: by + dy, z: wz + h.dz * d }];
    lines.push({ id: BLOCK.RAMP_TRANSITION, rot: h.asc145, points: at(4, 0) });
    lines.push({ id: BLOCK.RAMP_SLOPE,      rot: h.asc146, points: at(12, 2) });
    lines.push({ id: BLOCK.RAMP_SLOPE,      rot: h.dsc146, points: at(24, 2) });
    lines.push({ id: BLOCK.RAMP_TRANSITION, rot: h.dsc145, points: at(32, 0) });
  }
  state.shapes.push({ label: `Hill ${h.label}${width > 1 ? ` ×${width}` : ''}`, lines });

  refreshShapeUI();
  toast(`Hill added → ${h.label} (snapped to ${h.angle}°), width ${width}`);
  dbg(`Hill: dir=${h.label} rots=${h.asc145},${h.asc146},${h.dsc146},${h.dsc145} base=(${bx},${by},${bz}) w=${width}`, 'ok');
}
