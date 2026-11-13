// Shared helpers: browser launch, tool (editor) driving, real-game import / analysis / driving.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(HERE, 'out');
export const GAME_URL = process.env.POLYTRACK_URL || 'https://app-polytrack.kodub.com/0.6.3/';
export const TOOL_URL = process.env.TOOL_URL || 'file://' + path.resolve(HERE, '../../index.html');
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => fs.existsSync(p));

export const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Metres per PolyTrack coordinate unit (game constant partSize). */
export const UNIT_M = 5;

export async function launch() {
  if (!CHROME) throw new Error('Chrome not found - set CHROME_PATH');
  fs.mkdirSync(OUT, { recursive: true });
  return puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--window-size=1280,800', '--mute-audio', '--allow-file-access-from-files'],
    defaultViewport: { width: 1280, height: 800 },
  });
}

// ── Editor (the tool under test) ───────────────────────────────────────────
export async function openTool(browser) {
  const page = await browser.newPage();
  page.toolErrors = [];
  page.on('pageerror', e => page.toolErrors.push(e.message));
  page.on('dialog', d => d.accept());
  // Elevation API mock: scenario sets page.elevation = (eastM, northM) => metres
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (!req.url().includes('open-elevation.com')) return req.continue();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
    const { locations } = JSON.parse(req.postData());
    const results = locations.map(l => {
      const [e, n] = lonLatToMetres(l.longitude, l.latitude);
      return { latitude: l.latitude, longitude: l.longitude, elevation: page.elevation ? page.elevation(e, n) : 0 };
    });
    req.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ results }) });
  });
  await page.goto(TOOL_URL, { waitUntil: 'load' });
  return page;
}

/** Set form fields by element id (inputs, selects, checkboxes), firing the events the UI listens for. */
export async function setFields(tool, fields) {
  await tool.evaluate(fields => {
    for (const [id, v] of Object.entries(fields)) {
      const el = document.getElementById(id);
      if (!el) throw new Error('no field #' + id);
      if (el.type === 'checkbox') { if (el.checked !== !!v) el.click(); }
      else { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  }, fields);
}

/** Click a visible button in the editor by its text. */
export async function toolClick(tool, text) {
  const ok = await tool.evaluate(text => {
    const b = [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && b.textContent.trim().includes(text));
    if (!b) return false; b.click(); return true;
  }, text);
  if (!ok) throw new Error('editor button not found: ' + text);
}

/** Click a "Generate" button and wait for the track code (or throw the editor's error message). */
export async function generate(tool, buttonText) {
  await tool.evaluate(() => { document.getElementById('outputCode').textContent = ''; document.getElementById('logBox').textContent = ''; });
  await toolClick(tool, buttonText);
  await tool.waitForFunction(() => {
    const log = document.getElementById('logBox');
    return log.textContent.startsWith('Done') || !!log.querySelector('.err');
  }, { timeout: 60000 });
  const r = await tool.evaluate(() => ({
    err: document.getElementById('logBox').querySelector('.err')?.textContent,
    code: document.getElementById('outputCode').textContent,
  }));
  if (r.err) throw new Error('editor error: ' + r.err);
  return r.code;
}

// KML helpers - same spherical model as the editor (R = 6371 km)
const LAT0 = 37.42, LON0 = -122.08, M_PER_DEG = 6371000 * Math.PI / 180;
export function metresToLonLat(e, n) { return [LON0 + e / (M_PER_DEG * Math.cos(LAT0 * Math.PI / 180)), LAT0 + n / M_PER_DEG]; }
export function lonLatToMetres(lon, lat) { return [(lon - LON0) * M_PER_DEG * Math.cos(LAT0 * Math.PI / 180), (lat - LAT0) * M_PER_DEG]; }
/** Build a KML document from [east, north] metre offsets. */
export function kml(pointsM) {
  const coords = pointsM.map(([e, n]) => { const [lon, lat] = metresToLonLat(e, n); return `${lon.toFixed(8)},${lat.toFixed(8)},0`; }).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>pin</name><Point><coordinates>${coords.split(' ')[0]}</coordinates></Point></Placemark><Placemark><LineString><coordinates>${coords}</coordinates></LineString></Placemark></Document></kml>`;
}

// ── Real game ──────────────────────────────────────────────────────────────
/** Open the real, unmodified game. Internals are reached through its public webpack chunk global. */
export async function openGame(browser) {
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('  [game pageerror]', e.message));
  await page.goto(GAME_URL, { waitUntil: 'networkidle2', timeout: 120000 });
  const ok = await page.evaluate(() => {
    self.webpackChunk.push([[Symbol('probe')], {}, req => { window.__req = req; }]);
    const r = window.__req; if (!r) return 'no webpack require';
    // Locate modules by shape rather than by (minified) id, so this survives game updates
    const G = window.__pt = {};
    for (const id of Object.keys(r.m)) {
      let e; try { e = r(id); } catch { continue; }
      if (!e || typeof e !== 'object') continue;
      for (const [k, v] of Object.entries(e)) {
        if (typeof v === 'function' && v.fromExportString) G.Track = v;
        if (v && typeof v === 'object' && v.Plane === 25 && v[25] === 'Plane') G.names = v;
      }
      if (typeof e.Hw === 'function' && Array.isArray(e.bK)) G.partConfig = e.Hw;
      if (e.Pq0 && e.I9Y && !G.three) G.three = e;
    }
    if (!G.Track || !G.names || !G.partConfig || !G.three) return 'game internals not found: ' + Object.keys(G);
    // Remember every scene the game renders, so the car can be located while driving
    const O3D = Object.values(G.three).find(v => typeof v === 'function' && v.prototype &&
      ['updateMatrixWorld', 'traverse', 'lookAt', 'add', 'attach'].every(k => Object.prototype.hasOwnProperty.call(v.prototype, k)));
    G.scenes = new Set();
    const orig = O3D.prototype.updateMatrixWorld;
    O3D.prototype.updateMatrixWorld = function (f) { if (this.isScene) G.scenes.add(this); return orig.call(this, f); };
    return true;
  });
  if (ok !== true) throw new Error(ok);
  return page;
}

async function gameButtons(page) {
  return page.evaluate(() => [...document.querySelectorAll('#ui button')].filter(b => b.offsetParent !== null && !b.disabled).map(b => b.innerText.trim().replace(/\s+/g, ' ')));
}
export async function gameClick(page, text, { exact = false, wait = 700 } = {}) {
  const ok = await page.evaluate((text, exact) => {
    const b = [...document.querySelectorAll('#ui button')].filter(b => b.offsetParent !== null && !b.disabled)
      .find(b => { const t = b.innerText.trim().replace(/\s+/g, ' '); return exact ? t === text : t.includes(text); });
    if (!b) return false; b.click(); return true;
  }, text, exact);
  if (!ok) throw new Error(`game button "${text}" not found; visible: ${JSON.stringify(await gameButtons(page))}`);
  await sleep(wait);
}

/**
 * Decode a track code with the game's own importer and analyse it with the game's own part footprints.
 * Returns part counts, overlapping tiles, connectivity from the start, checkpoint orders, etc.
 */
export async function analyze(game, code) {
  return game.evaluate(code => {
    const { Track, partConfig, names } = window.__pt;
    const res = Track.fromExportString(code);
    if (!res) return { decoded: false };
    const t = res.trackData, parts = [], occ = new Map(), byName = {};
    let overlapTiles = 0; const overlapping = new Set();
    t.forEachPart((x, y, z, id, rot, axis, color, cp, start) => {
      const idx = parts.length;
      const tiles = [];
      partConfig(id).tiles.rotated(rot, axis).forEach((tx, ty, tz) => tiles.push([x + tx, y + ty, z + tz]));
      parts.push({ x, y, z, id, name: names[id], rot, color, cp, start, tiles });
      byName[names[id]] = (byName[names[id]] || 0) + 1;
      for (const [a, b, c] of tiles) {
        const k = a + ',' + b + ',' + c;
        if (occ.has(k)) { overlapTiles++; overlapping.add(idx); overlapping.add(occ.get(k)); } else occ.set(k, idx);
      }
    });
    // Connectivity: parts are linked when their footprints touch side-by-side (allowing 1 tile of height change)
    const adj = parts.map(() => new Set());
    for (const [k, i] of occ) {
      const [a, b, c] = k.split(',').map(Number);
      for (const [da, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const db of [-1, 0, 1]) {
        const j = occ.get((a + da) + ',' + (b + db) + ',' + (c + dc));
        if (j !== undefined && j !== i) adj[i].add(j);
      }
    }
    const starts = parts.map((p, i) => p.start != null ? i : -1).filter(i => i >= 0);
    const seen = new Set(starts.slice(0, 1)); const queue = [...seen];
    while (queue.length) for (const j of adj[queue.pop()]) if (!seen.has(j)) { seen.add(j); queue.push(j); }
    const isFinish = p => /Finish/.test(p.name), isCp = p => p.cp != null;
    const unreachable = parts.filter((p, i) => !seen.has(i));
    // Solid coverage: fraction of the occupied bounding box (in tiles) that is actually occupied
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const k of occ.keys()) k.split(',').map(Number).forEach((v, i) => { mn[i] = Math.min(mn[i], v); mx[i] = Math.max(mx[i], v); });
    const st = t.getStartTransform();
    const fwd = st ? new window.__pt.three.Pq0(0, 0, 1).applyQuaternion(st.quaternion) : null;
    return {
      decoded: true, name: res.trackMetadata.name, author: res.trackMetadata.author,
      nParts: parts.length, byName, overlapTiles, overlappingParts: overlapping.size,
      starts: starts.length, finishes: parts.filter(isFinish).length,
      checkpointOrders: parts.filter(isCp).map(p => p.cp).sort((a, b) => a - b),
      unreachable: unreachable.length,
      unreachableKey: unreachable.filter(p => isFinish(p) || isCp(p)).length,
      bboxTiles: mx.map((v, i) => v - mn[i] + 1), occupiedTiles: occ.size,
      startPart: starts.length ? (({ x, y, z, rot }) => ({ x, y, z, rot }))(parts[starts[0]]) : null,
      startForward: fwd ? [Math.round(fwd.x), Math.round(fwd.z)] : null,
      parts: parts.map(({ tiles, ...p }) => p),
    };
  }, code);
}

/** Import a track through the game's real "Import" dialog. Leaves the game on the track's detail screen. */
export async function importTrack(game, code) {
  await game.bringToFront();
  for (let i = 0; i < 5; i++) {
    const bs = await gameButtons(game);
    if (bs.includes('Import')) break;
    if (bs.includes('Exit')) await gameClick(game, 'Exit', { exact: true });
    else if (bs.includes('Back')) await gameClick(game, 'Back', { exact: true });
    else await sleep(500);
  }
  await gameClick(game, 'Import', { exact: true });
  await game.evaluate(code => {
    const ta = document.querySelector('#ui textarea');
    ta.value = code; ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, code);
  await sleep(200);
  await gameClick(game, 'Import', { exact: true, wait: 1500 });
  const bs = await gameButtons(game);
  if (!bs.includes('Play')) await gameClick(game, 'Back', { exact: true }).catch(() => {});
  if (!bs.includes('Play')) throw new Error('game UI rejected the import; visible buttons: ' + JSON.stringify(bs.slice(0, 6)));
}

async function carState(game) {
  return game.evaluate(() => {
    // Cars are groups of 4 wheel meshes; ghosts / stale cars sit at the origin, so take the live one
    const all = [];
    for (const s of window.__pt.scenes) s.traverse(o => { if (o.name === 'Wheel0') all.push(o.position); });
    let wheels = [];
    for (let i = 0; i + 4 <= all.length; i += 4) {
      const g = all.slice(i, i + 4);
      if (g.some(p => p.x !== 0 || p.y !== 0 || p.z !== 0)) wheels = g;
    }
    const ui = document.getElementById('ui').innerText.replace(/\s+/g, ' ');
    const out = { ui, speed: +(ui.match(/(\d+)\s*km\/h/) || [0, 0])[1], cps: (ui.match(/(\d+)\/(\d+)/) || [''])[0], time: (ui.match(/Current (\d\d:\d\d\.\d{3})/) || [])[1] };
    if (wheels.length === 4) {
      const [f1, f2, r1, r2] = wheels;
      out.pos = [(f1.x + f2.x + r1.x + r2.x) / 4, (f1.y + f2.y + r1.y + r2.y) / 4, (f1.z + f2.z + r1.z + r2.z) / 4];
      out.fwd = [(f1.x + f2.x - r1.x - r2.x) / 2, (f1.z + f2.z - r1.z - r2.z) / 2];
    }
    return out;
  });
}

/**
 * Play the imported track in the real game and drive it.
 * route: [[xM, zM], ...] waypoints in game world metres - followed with a pure-pursuit autopilot.
 *        Without a route the car just holds the accelerator (straight tracks).
 * Resolves { finished, time, checkpoints, reason } - finished means the GAME registered a finish.
 */
export async function drive(game, { route = null, timeoutMs = 90000, maxSpeed = 70, shot = null } = {}) {
  await game.evaluate(() => window.__pt.scenes.clear());   // forget scenes of previous tracks
  await gameClick(game, 'Play', { wait: 2500 });
  const keys = { ArrowUp: false, ArrowLeft: false, ArrowRight: false, ArrowDown: false };
  const set = async (k, on) => { if (keys[k] !== on) { keys[k] = on; await (on ? game.keyboard.down(k) : game.keyboard.up(k)); } };
  const t0 = Date.now();
  let result = null, seg = 0, startY = null, last = null, movedAt = Date.now();
  while (!result) {
    const s = await carState(game); last = s;
    if (/PERSONAL BEST|try again and improve/i.test(s.ui)) { result = { finished: true }; break; }
    if (Date.now() - t0 > timeoutMs) { result = { finished: false, reason: 'timeout' }; break; }
    if (!s.pos) { await sleep(100); continue; }
    if (startY === null) startY = s.pos[1];
    if (s.pos[1] < startY - 15) { result = { finished: false, reason: 'car fell off the track' }; break; }
    if (s.speed > 3) movedAt = Date.now();
    if (Date.now() - movedAt > 12000) { result = { finished: false, reason: 'car is stuck' }; break; }
    let steer = 0, target = maxSpeed;
    if (route) {
      // advance along the route, then aim at a lookahead point
      const look = 9 + s.speed * 0.12;
      while (seg < route.length - 2 && Math.hypot(route[seg + 1][0] - s.pos[0], route[seg + 1][1] - s.pos[2]) < look) seg++;
      const [ax, az] = route[seg], [bx, bz] = route[seg + 1];
      const L = Math.hypot(bx - ax, bz - az) || 1;
      const tProj = Math.max(0, Math.min(1, ((s.pos[0] - ax) * (bx - ax) + (s.pos[2] - az) * (bz - az)) / (L * L)));
      const tAim = Math.min(1, tProj + look / L);
      const aim = [ax + (bx - ax) * tAim, az + (bz - az) * tAim];
      const to = [aim[0] - s.pos[0], aim[1] - s.pos[2]];
      const f = s.fwd, fl = Math.hypot(...f) || 1, tl = Math.hypot(...to) || 1;
      const cross = (f[1] * to[0] - f[0] * to[1]) / (fl * tl);   // < 0: target is to the right
      const dot = (f[0] * to[0] + f[1] * to[1]) / (fl * tl);
      const err = Math.atan2(-cross, dot);                        // > 0: steer right
      if (Math.abs(err) > 0.03) steer = err > 0 ? 1 : -1;
      // slow down for the corner at the end of this segment and when pointing the wrong way
      const distToCorner = (1 - tProj) * L;
      if (seg < route.length - 2 && distToCorner < 45) target = 32;
      if (Math.abs(err) > 0.35) target = 25;
    }
    await set('ArrowRight', steer > 0); await set('ArrowLeft', steer < 0);
    await set('ArrowUp', s.speed < target); await set('ArrowDown', s.speed > target + 15);
    await sleep(25);
  }
  for (const k of Object.keys(keys)) await set(k, false);
  if (shot) await game.screenshot({ path: path.join(OUT, shot) });
  result.time = last?.time; result.checkpoints = last?.cps;
  if (last?.pos) result.lastPos = last.pos.map(v => Math.round(v));
  return result;
}

export async function screenshot(page, name) { await page.screenshot({ path: path.join(OUT, name) }); }

// ── Looking at a track from above ──────────────────────────────────────────
/**
 * Start playing the imported track, park the game's camera straight above (cxM, czM) metres looking
 * down (north / -Z at the top of the screen), hide the HUD and take a screenshot.
 * Returns { img, toScreen(xM, zM) → [px, py] } for sampling on-screen colours.
 */
export async function topDownShot(game, { cxM, czM, heightM = 420, file }) {
  await game.evaluate(() => window.__pt.scenes.clear());
  await gameClick(game, 'Play', { wait: 3000 });
  const view = await game.evaluate((cx, cz, H) => {
    const cams = [];
    for (const s of window.__pt.scenes) s.traverse(o => { if (o.isPerspectiveCamera) cams.push(o); });
    for (const c of cams) {
      const orig = Object.getPrototypeOf(c).updateMatrixWorld;
      c.updateMatrixWorld = function (f) {
        this.position.set(cx, H, cz); this.up.set(0, 0, -1); this.lookAt(cx, 0, cz);
        this.updateMatrix(); return orig.call(this, f);
      };
    }
    document.getElementById('ui').style.visibility = 'hidden';
    const w = innerWidth, h = innerHeight;
    return new Promise(res => setTimeout(() => res({ w, h, pxPerM: (h / 2) / (H * Math.tan(cams[cams.length - 1].fov * Math.PI / 360)) }), 1500));
  }, cxM, czM, heightM);
  const shot = path.join(OUT, file);
  await game.screenshot({ path: shot });
  await game.evaluate(() => { document.getElementById('ui').style.visibility = ''; });
  return {
    img: decodePng(fs.readFileSync(shot)),
    toScreen: (xM, zM) => [view.w / 2 + (xM - cxM) * view.pxPerM, view.h / 2 + (zM - czM) * view.pxPerM],
  };
}

export function decodePng(buf) {   // minimal 8-bit RGB/RGBA PNG decoder (screenshots only)
  let pos = 8, w, h, ctype; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9]; }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, at: (x, y) => [...px.subarray((y * w + x) * bpp, (y * w + x) * bpp + 3)] };
}
export function samplePixels(img, x, y, r) {   // median colour (ignores thin seams between blocks) + spread
  const ch = [[], [], []];
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) img.at(Math.round(x) + i, Math.round(y) + j).forEach((v, k) => ch[k].push(v));
  for (const c of ch) c.sort((a, b) => a - b);
  const n = ch[0].length;
  return { rgb: ch.map(c => c[n >> 1]), spread: Math.max(...ch.map(c => c[Math.floor(n * 0.9)] - c[Math.floor(n * 0.1)])) };
}


/** The map preview exactly as the game draws it for this track code: { w, h, data: RGBA[] }. */
export async function gameThumbnail(game, code) {
  return game.evaluate(code => {
    const c = window.__pt.Track.fromExportString(code).trackData.createThumbnail();
    return { w: c.width, h: c.height, data: [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data] };
  }, code);
}
