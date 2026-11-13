'use strict';
// ══════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════

(function init() {
  initTheme();
  initKML();
  initShapes();
  initPixel();
  switchMode('kml');

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawKML, 100);
  });

  if (!('CompressionStream' in window)) {
    log('This browser does not support CompressionStream - track codes cannot be generated.', 'err');
  }
})();
