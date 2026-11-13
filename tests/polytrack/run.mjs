// End-to-end test of the editor against the REAL PolyTrack game, in headless Chrome.
//
// For every scenario:
//   1. the editor's real UI generates a track code,
//   2. the game's own importer decodes it and the game's own part footprints are used to check
//      for overlapping parts, gaps, reachability of checkpoints / finish, orientation, etc.,
//   3. the code is imported through the game's Import dialog and the car is actually driven
//      (autopilot) until the game itself registers a finish.
//
// Usage: node run.mjs [filter]      e.g. node run.mjs kml
import fs from 'node:fs';
import path from 'node:path';
import {
  launch, openTool, openGame, setFields, toolClick, generate, kml, analyze, importTrack, drive,
  screenshot, topDownShot, samplePixels, gameThumbnail, OUT, UNIT_M,
} from './lib.mjs';

// Travel directions in game coordinates. PlaneStart rotation r makes the car face DIRS[r].
const DIRS = { '-Z': [0, -1], '-X': [-1, 0], '+Z': [0, 1], '+X': [1, 0] };
const HILL_ANGLE = { '+Z': 0, '+X': 90, '-Z': 180, '-X': 270 };  // editor's hill direction angles

/** Add a line shape in the Shape Builder. */
async function addLine(tool, id, a, b, rot = 0) {
  await setFields(tool, { shapeType: 'line', lineId: id, lineRot: rot, lsx: a[0], lsy: a[1], lsz: a[2], lex: b[0], ley: b[1], lez: b[2] });
  await toolClick(tool, '+ Add Shape');
}
const toolState = tool => tool.evaluate(() => {
  const r = state.lastKML;
  return r && { blockPts: r.blockPts, start: r.lines.find(l => l.id === 92).points[0] };
});
/** Convert editor block coordinates to game world metres, using the decoded start part as the anchor. */
function routeFromTool(ts, a) {
  const dx = a.startPart.x - ts.start.x, dz = a.startPart.z - ts.start.z;
  return ts.blockPts.map(p => [(p.bx + dx) * UNIT_M, (p.bz + dz) * UNIT_M]);
}
const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;

/** KML scenario: generate from a path given in real-world metres [east, north]. */
function kmlScenario(name, pathM, { fields = {}, elevation = null, expect = {} } = {}) {
  return {
    name, driveOpts: { maxSpeed: 50, timeoutMs: 180000 },
    async build(tool) {
      tool.elevation = elevation;
      await setFields(tool, { kmlInput: kml(pathM), kmlTrackName: name, useElevation: !!elevation, ...fields });
      const code = await generate(tool, 'Generate Circuit Code');
      this.ts = await toolState(tool);
      this.pathM = pathM;
      return code;
    },
    route(a) { return routeFromTool(this.ts, a); },
    check(a) {
      const fails = [];
      // Real-world handedness: a left turn on the map must be a left turn in the game.
      // Game world is right-handed with Y up, so viewed from above a left turn has cross(X,Z) < 0.
      const p = this.pathM, b = this.ts.blockPts;
      for (let i = 1; i < p.length - 1; i++) {
        const real = sign((p[i][0] - p[i - 1][0]) * (p[i + 1][1] - p[i][1]) - (p[i][1] - p[i - 1][1]) * (p[i + 1][0] - p[i][0]));
        if (!real || b.length !== p.length) continue;
        const game = sign((b[i].bx - b[i - 1].bx) * (b[i + 1].bz - b[i].bz) - (b[i].bz - b[i - 1].bz) * (b[i + 1].bx - b[i].bx));
        if (game !== -real) fails.push(`track is mirrored: map turns ${real > 0 ? 'left' : 'right'} at corner ${i}, game turns ${game < 0 ? 'left' : 'right'}`);
        break;
      }
      // The car must start facing along the first road segment
      const d = [b[1].bx - b[0].bx, b[1].bz - b[0].bz];
      const want = Math.abs(d[0]) > Math.abs(d[1]) ? [sign(d[0]), 0] : [0, sign(d[1])];
      if (a.startForward && (a.startForward[0] !== want[0] || a.startForward[1] !== want[1]))
        fails.push(`start faces (${a.startForward}) but the road leaves towards (${want})`);
      for (const [k, v] of Object.entries(expect)) {
        const got = k.split('.').reduce((o, key) => o?.[key], a) ?? 0;
        if (typeof v === 'function' ? !v(got) : got !== v) fails.push(`expected ${k} ${typeof v === 'function' ? v : '= ' + v}, got ${got}`);
      }
      return fails;
    },
  };
}

/** Hill inserter scenario: start, 3 road blocks, hill, 3 road blocks, finish - in one direction. */
function hillScenario(dir) {
  const [dx, dz] = DIRS[dir], rot = Object.keys(DIRS).indexOf(dir);
  const at = n => [dx * n, 0, dz * n];
  return {
    name: `hill ${dir}`,
    async build(tool) {
      await tool.evaluate(() => switchMode('shape'));
      await addLine(tool, 92, at(-12), at(-12), rot);       // start, facing the hill
      await addLine(tool, 25, at(-8), at(0));               // road up to the hill base
      await setFields(tool, { hillAngleTxt: HILL_ANGLE[dir], hillX: 0, hillY: 0, hillZ: 0, hillWidth: 1 });
      await toolClick(tool, 'Add Hill to List');
      // Documented contract: road continues 9 blocks (36 units) after the base block
      await addLine(tool, 25, at(36), at(44));
      await addLine(tool, 76, at(48), at(48), rot);       // finish gate must face the travel direction
      await setFields(tool, { shapeTrackName: this.name });
      return generate(tool, 'Generate Track Code');
    },
    check(a) {
      const fails = [];
      if ((a.byName.PlaneSlopeUpLong || 0) !== 2 || (a.byName.PlaneSlopeDownLong || 0) !== 2) fails.push('expected 2 + 2 ramp parts, got ' + JSON.stringify(a.byName));
      return fails;
    },
  };
}

/** A colourful 320×240 scene (sky gradient, sun, cloud, hill, house) drawn in the browser. */
function drawTestPicture() {
        const c = document.createElement('canvas'); c.width = 320; c.height = 240;
        const g = c.getContext('2d');
        const sky = g.createLinearGradient(0, 0, 0, 150); sky.addColorStop(0, '#2a3a9a'); sky.addColorStop(1, '#8fd0ff');
        g.fillStyle = sky; g.fillRect(0, 0, 320, 150);
        g.fillStyle = '#f2e9a0'; g.beginPath(); g.arc(250, 55, 30, 0, 7); g.fill();                     // sun
        g.fillStyle = '#2f8a4a'; g.beginPath(); g.moveTo(0, 240); g.quadraticCurveTo(110, 60, 230, 240); g.fill();   // hill
        g.fillStyle = '#7a4a2a'; g.fillRect(0, 200, 320, 40);                                             // soil
        g.fillStyle = '#a02830'; g.fillRect(200, 150, 70, 50);                                            // house
        g.fillStyle = '#151515'; g.beginPath(); g.moveTo(190, 150); g.lineTo(235, 115); g.lineTo(280, 150); g.fill();
        g.fillStyle = '#7b3fa0'; g.fillRect(226, 170, 18, 30);                                            // door
        g.fillStyle = '#ffffff'; g.fillRect(30, 30, 60, 18); g.fillRect(45, 20, 40, 12);                  // cloud
        return c.toDataURL('image/png');
      }

const scenarios = [
  {
    name: 'shape straight line',
    async build(tool) {
      await tool.evaluate(() => switchMode('shape'));
      await addLine(tool, 92, [0, 0, 0], [0, 0, 0]);
      await addLine(tool, 25, [0, 0, -4], [0, 0, -80]);
      await addLine(tool, 76, [0, 0, -84], [0, 0, -84]);
      await setFields(tool, { shapeTrackName: this.name });
      return generate(tool, 'Generate Track Code');
    },
    check: a => a.byName.Plane === 20 ? [] : [`expected 20 road parts for an 80-unit line, got ${a.byName.Plane}`],
  },
  {
    name: 'shape diagonal line',
    async build(tool) {
      await tool.evaluate(() => switchMode('shape'));
      await addLine(tool, 92, [0, 0, 0], [0, 0, 0], 0);
      await addLine(tool, 25, [0, 0, -4], [-60, 0, -100]);
      await addLine(tool, 76, [-60, 0, -104], [-60, 0, -104]);
      await setFields(tool, { shapeTrackName: this.name });
      this.pts = [[0, 0], [0, -4], [-60, -100], [-60, -104]];
      return generate(tool, 'Generate Track Code');
    },
    route(a) { return this.pts.map(([x, z]) => [(x + a.startPart.x) * UNIT_M, (z + a.startPart.z + 0) * UNIT_M]); },
    anchorStart: [0, 0],
  },
  {
    name: 'shape filled rectangle', noDrive: true,
    async build(tool) {
      await tool.evaluate(() => switchMode('shape'));
      await setFields(tool, { shapeType: 'filledRect', rectPlane: 'xz', fixedCoord: 0, rectMin1: 0, rectMax1: 40, rectMin2: 0, rectMax2: 40, rectId: 25 });
      await toolClick(tool, '+ Add Shape');
      await addLine(tool, 92, [0, 1, 0], [0, 1, 0]);
      return generate(tool, 'Generate Track Code');
    },
    check: a => a.byName.Plane === 121 ? [] : [`expected 11×11 = 121 road parts, got ${a.byName.Plane}`],
    skipReach: true,
  },
  {
    name: 'shape hollow + filled cube', noDrive: true, skipReach: true,
    async build(tool) {
      await tool.evaluate(() => switchMode('shape'));
      await setFields(tool, { shapeType: 'hollowCube', hcMinX: 0, hcMinY: 0, hcMinZ: 0, hcMaxX: 16, hcMaxY: 4, hcMaxZ: 16, hcId: 25 });
      await toolClick(tool, '+ Add Shape');
      await setFields(tool, { shapeType: 'filledCube', fcMinX: 40, fcMinY: 0, fcMinZ: 0, fcMaxX: 48, fcMaxY: 2, fcMaxZ: 8, fcId: 25 });
      await toolClick(tool, '+ Add Shape');
      await addLine(tool, 92, [0, 5, 0], [0, 5, 0]);
      return generate(tool, 'Generate Track Code');
    },
  },
  {
    name: 'ID test track (all IDs 0-255)', noDrive: true, skipReach: true, allowOverlap: true, noStart: true,
    async build(tool) {
      await tool.evaluate(() => switchMode('shape'));
      await setFields(tool, { minId: 0, maxId: 255 });
      await toolClick(tool, 'Generate ID Test Track');
      return generate(tool, 'Generate Track Code');
    },
    check: a => a.nParts >= 150 ? [] : [`expected a part for every valid block ID, got only ${a.nParts}`],
  },
  {
    name: 'track without a start block warns in the editor', noDrive: true, noStart: true, skipReach: true,
    async build(tool) {
      await tool.evaluate(() => switchMode('shape'));
      await addLine(tool, 25, [0, 0, 0], [0, 0, -40]);
      const code = await generate(tool, 'Generate Track Code');
      this.warned = await tool.evaluate(() => /no start block/i.test(document.getElementById('logBox').textContent));
      return code;
    },
    check() { return this.warned ? [] : ['the editor did not warn that the track has no start block']; },
  },
  ...Object.keys(DIRS).map(hillScenario),
  ...[['auto', false], ['Summer', true]].map(([envChoice, dither]) => ({
    // A colourful 32×24 scene. After import, the game is photographed from straight above and every
    // pixel's on-screen colour is compared with the colour the editor's preview promised.
    name: `pixel art, in-game view (${envChoice} environment${dither ? ', dithered' : ''})`, noDrive: true, skipReach: true,
    async build(tool) {
      await tool.evaluate(() => switchMode('pixel'));
      const png = path.join(OUT, 'pixel-input.png');
      const dataUrl = await tool.evaluate(drawTestPicture);
      fs.writeFileSync(png, Buffer.from(dataUrl.split(',')[1], 'base64'));
      await (await tool.$('#imgUpload')).uploadFile(png);
      await setFields(tool, { resValue: 32, pixelTarget: 'game', pixelEnv: envChoice, pixelDither: dither });
      await toolClick(tool, 'Preview Image');
      await tool.waitForFunction(() => state.pixels, { timeout: 5000 });
      this.px = await tool.evaluate(() => ({ w: state.pixels.w, h: state.pixels.h, env: state.pixels.env,
        cells: [...state.pixels.cells].map(c => c < 0 ? null : state.pixels.palette[c]) }));
      return generate(tool, 'Generate Pixel Track');
    },
    check(a) {
      const fails = [];
      const blocks = this.px.cells.filter(c => c && c.id !== null).length;
      if (a.nParts !== blocks + 1) fails.push(`expected ${blocks} blocks + 1 start, got ${a.nParts} parts`);
      const kinds = new Set(a.parts.map(p => p.id + ':' + p.color)).size;
      if (kinds < 8) fails.push(`expected a rich palette, only ${kinds} block colours used`);
      return fails;
    },
    async inGame(game, a, slug) {
      // start block sits at editor (-8, -8); pixel (x, y) at editor (4x, 4y)
      const dx = a.startPart.x + 8, dz = a.startPart.z + 8, { w, h, cells, env } = this.px;
      const view = await topDownShot(game, { cxM: (dx + (w - 1) * 2) * UNIT_M, czM: (dz + (h - 1) * 2) * UNIT_M, file: `${slug}-game-topdown.png` });
      let sum = 0, worst = 0, bad = 0;
      cells.forEach((c, i) => {
        if (!c) return;
        const [sx, sy] = view.toScreen((dx + (i % w) * 4) * UNIT_M, (dz + Math.floor(i / w) * 4) * UNIT_M);
        const got = samplePixels(view.img, sx, sy, 4).rgb;
        const d = Math.max(...got.map((v, k) => Math.abs(v - c.rgb[k])));
        sum += d; worst = Math.max(worst, d); if (d > 30) bad++;
      });
      const mean = sum / cells.length;
      const info = `rendered in ${env}: mean colour error ${mean.toFixed(1)}/255, worst ${worst}, ${bad}/${cells.length} pixels off`;
      // a few pixels sit in the shadow of a neighbouring raised block, so allow a small fraction
      return { info, fails: mean > 8 || bad > cells.length * 0.05 ? [`in-game colours differ from the editor preview (${info})`] : [] };
    },
  })),
  ...[['auto', false], ['Desert', true]].map(([envChoice, dither]) => ({
    // Pixel art for the game's MAP PREVIEW (the picture on a track's page). The editor's prediction is
    // compared pixel-for-pixel with the preview the game itself draws for the generated track.
    name: `pixel art, map preview (${envChoice} environment${dither ? ', dithered' : ''})`, noDrive: true, skipReach: true, noStart: true,
    async build(tool) {
      await tool.evaluate(() => switchMode('pixel'));
      const png = path.join(OUT, 'pixel-input.png');
      fs.writeFileSync(png, Buffer.from((await tool.evaluate(drawTestPicture)).split(',')[1], 'base64'));
      await (await tool.$('#imgUpload')).uploadFile(png);
      await setFields(tool, { resValue: 48, pixelTarget: 'preview', pixelEnv: envChoice, pixelDither: dither });
      await toolClick(tool, 'Preview Image');
      await tool.waitForFunction(() => state.pixels, { timeout: 5000 });
      this.px = await tool.evaluate(() => ({ w: state.pixels.w, h: state.pixels.h, env: state.pixels.env,
        cells: [...state.pixels.cells].map(c => c < 0 ? null : state.pixels.palette[c]) }));
      const code = await generate(tool, 'Generate Pixel Track');
      this.code = code;
      return code;
    },
    check(a) {
      const used = new Set(this.px.cells.filter(Boolean).map(c => String(c.id))).size;
      return used >= 4 ? [] : [`expected at least 4 of the 5 preview colours to be used, got ${used}`];
    },
    async inGame(game) {
      const { w, h, cells, env } = this.px;
      const thumb = await gameThumbnail(game, this.code);
      // the game crops its preview to the blocks' bounding box
      const filled = cells.map((c, i) => c && c.id !== null ? i : -1).filter(i => i >= 0);
      const minX = Math.min(...filled.map(i => i % w)), minY = Math.min(...filled.map(i => Math.floor(i / w)));
      let wrong = 0;
      for (let y = 0; y < thumb.h; y++) for (let x = 0; x < thumb.w; x++) {
        const c = cells[(y + minY) * w + (x + minX)], o = (y * thumb.w + x) * 4;
        const empty = !c || c.id === null;
        if (empty ? thumb.data[o + 3] !== 0 : (thumb.data[o + 3] !== 255 || c.rgb.some((v, k) => v !== thumb.data[o + k]))) wrong++;
      }
      const info = `game preview ${thumb.w}×${thumb.h} (${env}): ${wrong} of ${thumb.w * thumb.h} pixels differ from the editor's preview`;
      return { info, fails: wrong ? [info] : [] };
    },
  })),
  kmlScenario('kml straight north', [[0, 0], [0, 400]], { expect: { 'byName.Plane': v => v <= 22 } }),
  kmlScenario('kml straight east', [[0, 0], [400, 0]]),
  kmlScenario('kml L-turn (left on the map)', [[0, 0], [300, 0], [300, 300]], { expect: { 'checkpointOrders.length': v => v >= 1 } }),
  kmlScenario('kml circuit with diagonals', [[0, 0], [300, 0], [500, 200], [500, 500], [200, 600], [0, 400], [0, 60]],
    { expect: { 'checkpointOrders.length': v => v >= 4 } }),
  kmlScenario('kml circuit, road width 3', [[0, 0], [300, 0], [300, 300], [0, 300], [0, 60]], { fields: { roadWidth: 3 } }),
  kmlScenario('kml elevation: climb then descend around a corner', [[0, 0], [400, 0], [400, 400]],
    { elevation: (e, n) => 40 * Math.min(1, e / 400) * (1 - Math.max(0, n) / 400),
      expect: { 'byName.PlaneSlopeUpLong': v => v >= 2, 'byName.PlaneSlopeDownLong': v => v >= 2 } }),
  kmlScenario('kml elevation: hill in the middle of a straight road', [[0, 0], [800, 0]],
    { elevation: e => 20 * Math.max(0, 1 - Math.abs(e - 400) / 200),
      expect: { 'byName.PlaneSlopeUpLong': v => v >= 2 } }),
];

// ── Runner ─────────────────────────────────────────────────────────────────
const filter = (process.argv[2] || '').toLowerCase();
const browser = await launch();
const game = await openGame(browser);
const results = [];
for (const sc of scenarios.filter(s => s.name.toLowerCase().includes(filter))) {
  const slug = sc.name.replace(/\+/g, 'plus').replace(/-(?=[XZ])/g, 'minus').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const fails = []; let info = '';
  process.stdout.write(`\n▶ ${sc.name}\n`);
  const tool = await openTool(browser);
  try {
    // The game refuses to import a second track with the same name, so every scenario gets its own
    await setFields(tool, { kmlTrackName: sc.name, shapeTrackName: sc.name, pixelTrackName: sc.name });
    const code = await sc.build(tool);
    await screenshot(tool, `${slug}-editor.png`);
    fs.writeFileSync(path.join(OUT, `${slug}.txt`), code);
    if (tool.toolErrors.length) fails.push('editor JS errors: ' + tool.toolErrors.join('; '));

    const a = await analyze(game, code);
    if (!a.decoded) fails.push('the game\'s importer rejected the track code');
    else {
      info = `${a.nParts} parts ${JSON.stringify(a.byName)}`;
      if (a.overlapTiles && !sc.allowOverlap) fails.push(`${a.overlappingParts} parts overlap each other (${a.overlapTiles} shared tiles)`);
      if (!sc.noStart && a.starts !== 1) fails.push(`expected exactly 1 start, found ${a.starts}`);
      const orders = [...new Set(a.checkpointOrders)];
      if (orders.some((o, i) => o !== i)) fails.push(`checkpoint orders are not a gap-free 0..n sequence: ${orders}`);
      if (!sc.skipReach) {
        if (!a.finishes) fails.push('no finish part');
        if (a.unreachableKey) fails.push(`${a.unreachableKey} checkpoint/finish parts are not connected to the start by road`);
        else if (a.unreachable) fails.push(`${a.unreachable} parts are not connected to the start`);
      }
      fails.push(...(sc.check?.(a) || []));

      // The real thing: import through the game UI and drive it
      await importTrack(game, code);
      await screenshot(game, `${slug}-game-imported.png`);
      if (sc.inGame) {
        const r = await sc.inGame(game, a, slug);
        info += ' | ' + r.info; fails.push(...r.fails);
      }
      if (!sc.noDrive) {
        const d = await drive(game, { route: sc.route?.(a), shot: `${slug}-game-drive.png`, ...(sc.driveOpts || {}) });
        info += ` | drive: ${d.finished ? 'FINISHED in ' + d.time : 'did not finish'} (checkpoints ${d.checkpoints || '-'})`;
        if (!d.finished) fails.push(`car could not finish the track in the game: ${d.reason} at ${d.lastPos} (checkpoints ${d.checkpoints || '-'})`);
      }
    }
  } catch (e) {
    fails.push('exception: ' + e.message.split('\n')[0]);
  }
  await tool.close();
  results.push({ name: sc.name, fails, info });
  console.log(fails.length ? `  ✗ FAIL\n    - ${fails.join('\n    - ')}` : '  ✓ PASS');
  if (info) console.log('    ' + info);
}
await browser.close();

const failed = results.filter(r => r.fails.length);
console.log(`\n══ ${results.length - failed.length}/${results.length} scenarios passed ══`);
for (const r of results) console.log(`${r.fails.length ? '✗' : '✓'} ${r.name}`);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
