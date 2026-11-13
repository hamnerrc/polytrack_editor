'use strict';
// ══════════════════════════════════════════════════
// GEOMETRY HELPERS
// ══════════════════════════════════════════════════

/**
 * 3D Bresenham line between two integer points (inclusive).
 * Inputs are rounded so non-integer coordinates can never cause an infinite loop.
 */
function line3D(x1, y1, z1, x2, y2, z2) {
  [x1, y1, z1, x2, y2, z2] = [x1, y1, z1, x2, y2, z2].map(Math.round);
  const pts = [], dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  let x = x1, y = y1, z = z1;
  if (ax >= ay && ax >= az) {
    let yd = ay - ax / 2, zd = az - ax / 2;
    for (;;) {
      pts.push({ x, y, z });
      if (x === x2) return pts;
      x += sx;
      if (yd >= 0) { y += sy; yd -= ax; } yd += ay;
      if (zd >= 0) { z += sz; zd -= ax; } zd += az;
    }
  } else if (ay >= ax && ay >= az) {
    let xd = ax - ay / 2, zd = az - ay / 2;
    for (;;) {
      pts.push({ x, y, z });
      if (y === y2) return pts;
      y += sy;
      if (xd >= 0) { x += sx; xd -= ay; } xd += ax;
      if (zd >= 0) { z += sz; zd -= ay; } zd += az;
    }
  } else {
    let xd = ax - az / 2, yd = ay - az / 2;
    for (;;) {
      pts.push({ x, y, z });
      if (z === z2) return pts;
      z += sz;
      if (xd >= 0) { x += sx; xd -= az; } xd += ax;
      if (yd >= 0) { y += sy; yd -= az; } yd += ay;
    }
  }
}

/** Great-circle distance in metres. */
function haversineM(lon1, lat1, lon2, lat2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/** Convert lon/lat coordinates to local metres (x = east, z = north) relative to the first point. */
function toLocal(coords) {
  const o = coords[0];
  return coords.map(c => ({
    x: haversineM(o.lon, o.lat, c.lon, o.lat) * (c.lon >= o.lon ? 1 : -1),
    z: haversineM(o.lon, o.lat, o.lon, c.lat) * (c.lat >= o.lat ? 1 : -1),
    alt: c.alt,
  }));
}

/**
 * Ramer–Douglas–Peucker simplification on the XZ plane.
 * Returns the sorted indices of the points to keep, so callers can map back to source data.
 */
function rdpIndices(pts, eps) {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const kept = [0];
  // Iterative stack instead of recursion, so very long paths can't overflow the call stack
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end - start < 2) continue;
    const s = pts[start], e = pts[end];
    const dx = e.x - s.x, dz = e.z - s.z, len = Math.hypot(dx, dz);
    let maxD = 0, maxI = start + 1;
    for (let i = start + 1; i < end; i++) {
      const d = len === 0
        ? Math.hypot(pts[i].x - s.x, pts[i].z - s.z)
        : Math.abs(dz * pts[i].x - dx * pts[i].z + e.x * s.z - e.z * s.x) / len;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps) {
      kept.push(maxI);
      stack.push([start, maxI], [maxI, end]);
    }
  }
  kept.push(n - 1);
  return kept.sort((a, b) => a - b);
}

/** Angle in degrees between two 2D vectors. */
function angleBetween(ax, az, bx, bz) {
  const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
  if (!la || !lb) return 0;
  return Math.acos(clamp((ax * bx + az * bz) / (la * lb), -1, 1)) * 180 / Math.PI;
}

/** Snap a travel vector to a cardinal index (see CARDINALS). */
function snapCardinal(dx, dz) {
  if (Math.abs(dz) >= Math.abs(dx)) return dz <= 0 ? 0 : 2;
  return dx <= 0 ? 1 : 3;
}
