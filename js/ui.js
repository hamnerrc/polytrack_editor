'use strict';
// ══════════════════════════════════════════════════
// THEME · TOAST · STATUS LOG · DEBUG CONSOLE · MODES
// ══════════════════════════════════════════════════

const THEME_KEY = 'pt-theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('themeBtn');
  btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  btn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111827' : '#ffffff');
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage unavailable */ }
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  applyTheme(saved === 'light' || saved === 'dark' ? saved : (prefersLight ? 'light' : 'dark'));
}

function toggleTheme() {
  const next = isDarkTheme() ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
  redrawCanvases();
}

// ── Toast ──────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2300);
}

// ── Status line (next to the code output) ──────────
function log(msg, cls = '') {
  const box = $('logBox');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = msg;
  box.replaceChildren(span);
}

// ── Debug console ──────────────────────────────────
const DEBUG_MAX = 200;
function dbg(msg, cls = '') {
  const el = $('debugLog');
  const ts = new Date().toLocaleTimeString('en', { hour12: false });
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${ts}] ${msg}`;
  el.appendChild(line);
  while (el.childElementCount > DEBUG_MAX) el.firstElementChild.remove();
  el.scrollTop = el.scrollHeight;
}
function clearDbg() { $('debugLog').replaceChildren(); }
function toggleDebug() {
  const panel = $('dbgPanel');
  panel.hidden = !panel.hidden;
  $('dbgToggle').textContent = panel.hidden ? '▶ expand' : '▼ collapse';
}

/** Report an error to the status line, debug console and toast. */
function reportError(e) {
  console.error(e);
  dbg('ERROR: ' + e.message, 'err');
  log(e.message, 'err');
  toast('Error - see debug log');
}

// ── Stats bar ──────────────────────────────────────
function setStat(key, value, label) {
  $('s' + key).textContent = value ?? '-';
  if (label !== undefined) $('sl' + key).textContent = label;
}

// ── Mode switching ─────────────────────────────────
const MODES = {
  kml:   { info: 'KML → 1:1 REAL-WORLD CIRCUIT', labels: { A: 'KML Points', B: 'Road Blocks', C: 'Checkpoints', D: 'Circuit Length' } },
  shape: { info: 'MANUAL SHAPE BUILDER',         labels: { A: 'Shapes', B: 'Total Blocks', C: 'Unique IDs', D: '' } },
  pixel: { info: 'IMAGE → PIXEL ART TRACK',      labels: { A: 'Pixels', B: 'Width (px)', C: 'Height (px)', D: '' } },
};

function switchMode(mode) {
  state.mode = mode;
  for (const name of Object.keys(MODES)) {
    $('tab-' + name).classList.toggle('on', name === mode);
    $('sb-' + name).hidden = name !== mode;
  }
  $('kmlWrap').hidden = mode !== 'kml';
  $('pixPanel').hidden = !(mode === 'pixel' && state.pixels);
  $('topInfo').textContent = MODES[mode].info;

  // Reset per-mode stats so values from another mode never linger
  for (const [key, label] of Object.entries(MODES[mode].labels)) setStat(key, '-', label);

  if (mode === 'kml') { refreshKMLStats(); redrawKML(); }
  if (mode === 'shape') { refreshShapeUI(); updateHillPreview(num('hillAngleTxt', 0)); }
  if (mode === 'pixel') { refreshPixelStats(); drawPixelPreview(); }
}

function redrawCanvases() {
  redrawKML();
  drawPixelPreview();
  updateHillPreview(num('hillAngleTxt', 0));
}
