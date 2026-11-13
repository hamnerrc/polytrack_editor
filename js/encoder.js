'use strict';
// ══════════════════════════════════════════════════
// TRACK ENCODING (PolyTrack1 format)
// ══════════════════════════════════════════════════

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

async function zlibCompress(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** PolyTrack's variable-width base-62 bit packing. */
function encode62(buf) {
  let b = 0, r = '';
  while (b < buf.length * 8) {
    const bi = b >>> 3, off = b & 7;
    if (bi >= buf.length) break;
    let v = off <= 2 || bi >= buf.length - 1
      ? (buf[bi] >>> off) & 63
      : ((buf[bi] >>> off) & 63) | ((buf[bi + 1] & (63 >>> (8 - off))) << (8 - off));
    if ((v & 30) === 30) { v &= 31; b += 5; } else b += 6;
    r += BASE62[v];
  }
  return r;
}

/** Bytes needed to store coordinate values up to `max`. */
const byteWidth = max => max < 128 ? 1 : max < 32768 ? 2 : max < 8388608 ? 3 : 4;
const writeU32 = (b, v) => b.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255);
const writeN = (b, v, n) => { for (let i = 0; i < n; i++) b.push((v >> (i * 8)) & 255); };

/** Extra per-block payload bytes required by certain block IDs. */
function writeExtra(bin, id, block) {
  if (id === BLOCK.CHECKPOINT) bin.push(block.cpIdx & 0xff, 0);
  if (id === 65 || id === 77) bin.push(0, 0);
  if (id === 91 || id === 92 || id === 93) writeU32(bin, 0);
}

/**
 * Serialize lines ({id, rot, points:[{x,y,z,cpIndex?}]}) into the PolyTrack binary block list.
 * Coordinates are shifted so all are non-negative; exact duplicate blocks are dropped.
 */
function buildBinary(lines) {
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity, count = 0;
  for (const l of lines) for (const p of l.points) {
    if (p.x < mnX) mnX = p.x; if (p.y < mnY) mnY = p.y; if (p.z < mnZ) mnZ = p.z;
    count++;
  }
  if (!count) return new Uint8Array(0);
  const sx = mnX < 0 ? -mnX : 0, sy = mnY < 0 ? -mnY : 0, sz = mnZ < 0 ? -mnZ : 0;

  const groups = new Map();
  let mxX = 0, mxY = 0, mxZ = 0, dupes = 0;
  for (const l of lines) {
    const id = l.id;
    if (!groups.has(id)) groups.set(id, { blocks: [], seen: new Set() });
    const g = groups.get(id);
    const rot = l.rot || 0;
    for (const p of l.points) {
      const x = Math.round(p.x + sx), y = Math.round(p.y + sy), z = Math.round(p.z + sz);
      const key = `${x},${y},${z},${rot}`;
      if (g.seen.has(key)) { dupes++; continue; }
      g.seen.add(key);
      g.blocks.push({ x, y, z, rot, cpIdx: p.cpIndex ?? l.cpIndex ?? 0 });
      if (x > mxX) mxX = x; if (y > mxY) mxY = y; if (z > mxZ) mxZ = z;
    }
  }

  const bin = [];
  bin.push(0, 0); writeU32(bin, 0); writeU32(bin, 0); writeU32(bin, 0);
  const xB = byteWidth(mxX), yB = byteWidth(mxY), zB = byteWidth(mxZ);
  bin.push((zB << 4) | (yB << 2) | xB);
  dbg(`Binary: max=(${mxX},${mxY},${mxZ}) bw=(${xB},${yB},${zB}) shift=(${sx},${sy},${sz})`);

  const ids = [...groups.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const { blocks } = groups.get(id);
    bin.push(id);
    writeU32(bin, blocks.length);
    for (const b of blocks) {
      writeN(bin, b.x, xB); writeN(bin, b.y, yB); writeN(bin, b.z, zB);
      bin.push(b.rot, 0 /* dir */, 0 /* color */);
      writeExtra(bin, id, b);
    }
  }
  dbg(`Binary: ${bin.length} bytes - IDs: ${ids.map(id => `${id}×${groups.get(id).blocks.length}`).join(', ')}` +
      (dupes ? ` (${dupes} duplicate blocks skipped)` : ''), 'ok');
  return new Uint8Array(bin);
}

/** Encode a UTF-8 string, truncated so its byte length fits in one length byte. */
function encodeLabel(str) {
  const bytes = new TextEncoder().encode(str);
  return bytes.length <= 255 ? bytes : bytes.slice(0, 255);
}

async function encodeTrack(lines, name, author) {
  const bin = buildBinary(lines);
  const nb = encodeLabel(name), ab = encodeLabel(author);
  const full = new Uint8Array(2 + nb.length + ab.length + bin.length);
  let o = 0;
  full[o++] = nb.length; full.set(nb, o); o += nb.length;
  full[o++] = ab.length; full.set(ab, o); o += ab.length;
  full.set(bin, o);
  const inner = encode62(await zlibCompress(full));
  const outer = encode62(await zlibCompress(new TextEncoder().encode(inner)));
  return 'PolyTrack1' + outer;
}

// ── Output panel ───────────────────────────────────
function emitCode(code) {
  state.code = code;
  $('outputCode').textContent = code;
  setStat('E', (code.length / 1024).toFixed(1) + ' KB');
  log(`Done - ${code.length} chars`, 'ok');
  dbg(`Encoded: ${code.length} chars`, 'ok');
}

async function copyCode() {
  if (!state.code) { toast('Generate a track first'); return; }
  try {
    await navigator.clipboard.writeText(state.code);
    toast('Copied!');
  } catch {
    // Clipboard API can be blocked (e.g. file:// or no permission) - fall back to selecting the text
    const range = document.createRange();
    range.selectNodeContents($('outputCode'));
    const sel = getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    toast('Copy blocked by browser - text selected, press Ctrl/Cmd+C');
  }
}

function downloadCode() {
  if (!state.code) { toast('Generate a track first'); return; }
  const name = ($(state.mode + 'TrackName')?.value || 'polytrack').replace(/\W+/g, '_') || 'polytrack';
  downloadBlob(state.code, 'text/plain', name + '.txt');
}
