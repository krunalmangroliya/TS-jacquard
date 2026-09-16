import type { CleanupOptions, IndexedImage } from './types';

export type LineRepairOptions = Pick<CleanupOptions,
  'strength' | 'outlineColor' | 'protectedColors' | 'repeatX' | 'repeatY'>;
export interface LineRepairResult {
  pixels: Uint8Array;
  /** 1 only where a source-supported stroke was added. */
  additions: Uint8Array;
  repairedPixels: number;
  repairedPaths: number;
  reviewedCandidates: number;
  budgetExhausted: boolean;
}

/**
 * Recover short strokes lost by center-nearest sampling, in every palette ink.
 * A path must exist in the original source. Its actual course is projected onto
 * the output grid; we never draw a straight chord merely because ends are close.
 * The baseline is immutable, so repaired pixels cannot create fresh candidates.
 */
export function repairSourceLines(
  source: IndexedImage, baseline: IndexedImage, options: LineRepairOptions,
  onProgress?: (percent: number) => void,
): LineRepairResult {
  const w = baseline.width, h = baseline.height, n = w * h;
  if (baseline.pixels.length !== n || source.pixels.length !== source.width * source.height)
    throw new Error('Line repair received inconsistent pixel dimensions.');
  if (baseline.palette.length !== source.palette.length || baseline.palette.some((c, i) =>
    c.some((value, channel) => value !== source.palette[i][channel])))
    throw new Error('Source and output palette indexes must correspond for line repair.');
  const pixels = baseline.pixels.slice(), additions = new Uint8Array(n);
  const result: LineRepairResult = { pixels, additions, repairedPixels: 0,
    repairedPaths: 0, reviewedCandidates: 0, budgetExhausted: false };
  const sx = source.width / w, sy = source.height / h;
  if (options.outlineColor === null || sx < 1 || sy < 1) return result;
  const level = options.strength === 'gentle' ? 0 : options.strength === 'balanced' ? 1 : 2;
  const maxSpan = [3, 4, 5][level], maxNewPixels = [2, 3, 4][level];
  const locked = new Uint8Array(source.palette.length);
  for (const c of options.protectedColors) locked[c] = 1;
  const endpoint = new Uint8Array(n), vx = new Int8Array(n), vy = new Int8Array(n);
  const at = (x: number, y: number): number => {
    if (x < 0 || x >= w) { if (!options.repeatX) return -1; x = (x % w + w) % w; }
    if (y < 0 || y >= h) { if (!options.repeatY) return -1; y = (y % h + h) % h; }
    return y * w + x;
  };
  const sourceAt = (x: number, y: number): number => {
    if (x < 0 || x >= source.width) {
      if (!options.repeatX) return -1; x = (x % source.width + source.width) % source.width;
    }
    if (y < 0 || y >= source.height) {
      if (!options.repeatY) return -1; y = (y % source.height + source.height) % source.height;
    }
    return source.pixels[y * source.width + x];
  };

  // An endpoint has its existing ink on one side. Isolated surviving samples
  // can also be anchors, but only an exact source path can join them later.
  onProgress?.(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, color = baseline.pixels[i];
    if (locked[color]) continue;
    let count = 0, sumX = 0, sumY = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const j = at(x + dx, y + dy);
      if (j >= 0 && baseline.pixels[j] === color) { count++; sumX += dx; sumY += dy; }
    }
    if (count <= 4 && (count === 0 || sumX * sumX + sumY * sumY >= count * count * 0.3)) {
      endpoint[i] = count + 1; vx[i] = sumX; vy[i] = sumY;
    }
  }

  // Source searches reuse fixed storage. Budget counts actual inspected cells,
  // preventing an adversarial dense input from causing unbounded patch work.
  const MAX_PATCH = 8192, MAX_WORK = Math.min(100_000_000, Math.max(5_000_000, n * 30));
  const seen = new Uint32Array(MAX_PATCH), parent = new Int16Array(MAX_PATCH), queue = new Int16Array(MAX_PATCH);
  let stamp = 0, work = 0;
  const offsets: [number, number][] = [];
  for (let dy = -maxSpan; dy <= maxSpan; dy++) for (let dx = -maxSpan; dx <= maxSpan; dx++) {
    const distance = Math.max(Math.abs(dx), Math.abs(dy));
    if (distance >= 2 && distance <= maxSpan) offsets.push([dx, dy]);
  }
  offsets.sort((a, b) => Math.max(Math.abs(a[0]), Math.abs(a[1])) - Math.max(Math.abs(b[0]), Math.abs(b[1])) ||
    a[1] - b[1] || a[0] - b[0]);

  const support = (x: number, y: number, color: number): number => {
    const left = x * sx, right = (x + 1) * sx, top = y * sy, bottom = (y + 1) * sy;
    let area = 0;
    for (let yy = Math.floor(top); yy < Math.ceil(bottom); yy++) {
      const wy = Math.min(bottom, yy + 1) - Math.max(top, yy);
      for (let xx = Math.floor(left); xx < Math.ceil(right); xx++) {
        if (sourceAt(xx, yy) === color) area += wy * (Math.min(right, xx + 1) - Math.max(left, xx));
      }
    }
    return area / (sx * sy);
  };

  const trace = (ax: number, ay: number, bx: number, by: number, color: number): [number, number][] | null => {
    const startX = Math.floor((ax + 0.5) * sx), startY = Math.floor((ay + 0.5) * sy);
    const endX = Math.floor((bx + 0.5) * sx), endY = Math.floor((by + 0.5) * sy);
    if (sourceAt(startX, startY) !== color || sourceAt(endX, endY) !== color) return null;
    // About one output cell of excursion, preserving local curves but
    // excluding long routes around neighboring motifs and distant contours.
    const mx = Math.max(1, Math.ceil(sx * 1.25)), my = Math.max(1, Math.ceil(sy * 1.25));
    let left = Math.min(startX, endX) - mx, right = Math.max(startX, endX) + mx;
    let top = Math.min(startY, endY) - my, bottom = Math.max(startY, endY) + my;
    if (!options.repeatX) { left = Math.max(0, left); right = Math.min(source.width - 1, right); }
    if (!options.repeatY) { top = Math.max(0, top); bottom = Math.min(source.height - 1, bottom); }
    const bw = right - left + 1, bh = bottom - top + 1;
    if (bw * bh > MAX_PATCH) return null;
    result.reviewedCandidates++;
    stamp++;
    const start = (startY - top) * bw + startX - left, target = (endY - top) * bw + endX - left;
    queue[0] = start; seen[start] = stamp; parent[start] = -1;
    let head = 0, tail = 1, found = false;
    while (head < tail) {
      const p = queue[head++]; work++;
      if (work > MAX_WORK) { result.budgetExhausted = true; return null; }
      if (p === target) { found = true; break; }
      const px = p % bw, py = Math.floor(p / bw);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || nx >= bw || ny < 0 || ny >= bh) continue;
        const j = ny * bw + nx;
        if (seen[j] === stamp || sourceAt(left + nx, top + ny) !== color) continue;
        seen[j] = stamp; parent[j] = p; queue[tail++] = j;
      }
    }
    if (!found) return null;
    // A connected speckle network is not a stroke. Source-space gradient
    // agreement distinguishes directional ink from locally isotropic mottling.
    // This also works when only isolated samples of a true thin line survive.
    let xx = 0, yy = 0, xy = 0;
    for (let py = top; py <= bottom; py++) for (let px = left; px <= right; px++) {
      const gx = Number(sourceAt(px + 1, py) === color) - Number(sourceAt(px - 1, py) === color);
      const gy = Number(sourceAt(px, py + 1) === color) - Number(sourceAt(px, py - 1) === color);
      xx += gx * gx; yy += gy * gy; xy += gx * gy;
    }
    work += bw * bh;
    if (work > MAX_WORK) { result.budgetExhausted = true; return null; }
    const energy = xx + yy;
    const coherence = energy ? Math.sqrt((xx - yy) ** 2 + 4 * xy * xy) / energy : 0;
    if (coherence < [0.36, 0.24, 0.14][level]) return null;
    const projected: [number, number][] = [];
    for (let p = target; p >= 0; p = parent[p]) {
      const x = Math.floor((left + p % bw + 0.5) / sx), y = Math.floor((top + Math.floor(p / bw) + 0.5) / sy);
      const last = projected[projected.length - 1];
      if (!last || last[0] !== x || last[1] !== y) projected.push([x, y]);
    }
    projected.reverse();
    // Rasterize only the minimal connected course inside the actual projected
    // cells, avoiding 2-pixel stair corners introduced by source-grid traversal.
    const narrow: [number, number][] = [];
    for (let p = 0; p < projected.length;) {
      narrow.push(projected[p]);
      let next = p + 1;
      for (let q = p + 2; q < projected.length; q++) {
        if (Math.abs(projected[q][0] - projected[p][0]) <= 1 &&
          Math.abs(projected[q][1] - projected[p][1]) <= 1) next = q;
      }
      p = next;
    }
    return narrow;
  };

  // Primary outline is handled first for deterministic priority at conflicts.
  // Other inks receive exactly the same source-evidence and topology checks.
  for (let pass = 0; pass < 2 && !result.budgetExhausted; pass++) {
    for (let y = 0; y < h && !result.budgetExhausted; y++) {
      if ((y & 127) === 0) onProgress?.(10 + Math.round(90 * (pass + y / h) / 2));
      for (let x = 0; x < w && !result.budgetExhausted; x++) {
        const a = y * w + x, color = baseline.pixels[a];
        if (!endpoint[a] || (pass === 0) !== (color === options.outlineColor)) continue;
        for (const [dx, dy] of offsets) {
          const b = at(x + dx, y + dy);
          if (b <= a || !endpoint[b] || baseline.pixels[b] !== color) continue;
          // Both ends should point into the gap, not across parallel strokes.
          const distance = Math.hypot(dx, dy);
          if ((endpoint[a] > 1 && vx[a] * dx + vy[a] * dy > -0.15 * distance * Math.hypot(vx[a], vy[a])) ||
            (endpoint[b] > 1 && vx[b] * dx + vy[b] * dy < 0.15 * distance * Math.hypot(vx[b], vy[b]))) continue;
          const path = trace(x, y, x + dx, y + dy, color);
          if (result.budgetExhausted) break;
          if (!path) continue;
          const proposed: number[] = [];
          let valid = true;
          for (const [px, py] of path) {
            const i = at(px, py);
            if (i < 0) { valid = false; break; }
            const old = baseline.pixels[i];
            if (old === color || proposed.includes(i)) continue;
            if (locked[old] || (additions[i] && pixels[i] !== color)) { valid = false; break; }
            let oldNeighbors = 0;
            for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
              if (!ox && !oy) continue;
              const j = at(px + ox, py + oy);
              if (j >= 0 && baseline.pixels[j] === old) oldNeighbors++;
            }
            // Keep a small center/hole, and do not erase a competing thin ink.
            // Ordinary background at a broken stroke has 5-7 same-color neighbors.
            const inkSupport = support(px, py, color);
            if (oldNeighbors <= 2 || inkSupport < [0.045, 0.025, 0.012][level] ||
              (oldNeighbors <= 4 && support(px, py, old) >= inkSupport * 0.9)) { valid = false; break; }
            proposed.push(i);
          }
          if (!valid || !proposed.length || proposed.length > maxNewPixels) continue;
          let fresh = 0;
          for (const i of proposed) {
            if (!additions[i]) { fresh++; additions[i] = 1; }
            pixels[i] = color;
          }
          if (fresh) { result.repairedPixels += fresh; result.repairedPaths++; }
        }
      }
    }
  }
  onProgress?.(100);
  return result;
}
