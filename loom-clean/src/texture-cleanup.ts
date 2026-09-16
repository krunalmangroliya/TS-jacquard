import type { CleanupOptions, IndexedImage } from './types';

function wrappedExtent(values: number[], size: number, repeat: boolean): [number, number] {
  const lo = Math.min(...values), hi = Math.max(...values);
  if (!repeat || hi - lo < size / 2) return [lo, hi - lo + 1];
  const sorted = values.slice().sort((a, b) => a - b);
  let gap = -1, origin = lo;
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + size;
    if (next - sorted[i] > gap) { gap = next - sorted[i]; origin = next % size; }
  }
  return [origin, size - gap + 1];
}

/** Freeze complete small contours before splitting their diagonal links into grain. */
export function detectStructureMask(image: IndexedImage, options: Pick<CleanupOptions, 'repeatX' | 'repeatY'>): Uint8Array {
  const { width: w, height: h, pixels } = image, n = pixels.length;
  const mask = new Uint8Array(n), seen = new Uint8Array(n), queue = new Int32Array(n);
  const at = (x: number, y: number) => {
    if (x < 0 || x >= w) { if (!options.repeatX) return -1; x = (x % w + w) % w; }
    if (y < 0 || y >= h) { if (!options.repeatY) return -1; y = (y % h + h) % h; }
    return y * w + x;
  };
  for (let seed = 0; seed < n; seed++) {
    if (seen[seed]) continue;
    queue[0] = seed; seen[seed] = 1;
    let tail = 1;
    for (let head = 0; head < tail; head++) {
      const i = queue[head], x = i % w, y = Math.floor(i / w);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const j = at(x + dx, y + dy);
        if (j >= 0 && !seen[j] && pixels[j] === pixels[seed]) { seen[j] = 1; queue[tail++] = j; }
      }
    }
    if (tail < 4 || tail > 2048) continue;
    const xs: number[] = [], ys: number[] = [];
    for (let k = 0; k < tail; k++) { xs.push(queue[k] % w); ys.push(Math.floor(queue[k] / w)); }
    const [left, cw] = wrappedExtent(xs, w, options.repeatX), [top, ch] = wrappedExtent(ys, h, options.repeatY);
    if (cw > 256 || ch > 256 || cw * ch > 16384) continue;
    if (cw >= 2 && ch >= 2 && tail / (cw * ch) >= .72 && Math.max(cw / ch, ch / cw) < 3) {
      for (let k = 0; k < tail; k++) mask[queue[k]] = 1;
      continue;
    }
    const stride = cw + 2, cells = new Uint8Array(stride * (ch + 2));
    for (let k = 0; k < tail; k++) cells[((ys[k] - top + h) % h + 1) * stride + (xs[k] - left + w) % w + 1] = 1;
    const outside = new Int32Array(cells.length); outside[0] = 0; cells[0] = 2;
    let end = 1;
    for (let head = 0; head < end; head++) {
      const i = outside[head], x = i % stride, y = Math.floor(i / stride);
      for (const j of [x ? i - 1 : -1, x + 1 < stride ? i + 1 : -1, y ? i - stride : -1, y + 1 < ch + 2 ? i + stride : -1]) {
        if (j >= 0 && !cells[j]) { cells[j] = 2; outside[end++] = j; }
      }
    }
    const closed = cells.some(v => v === 0);
    // Curved hatching need not contain a hole or five collinear pixels. Its
    // 8-connected path is long, thin, and has very few branches.
    let branch = 0, junction = 0;
    if (!closed && Math.max(cw, ch) >= 7 && tail <= Math.max(cw, ch) * 3) {
      for (let k = 0; k < tail; k++) {
        const x = (xs[k] - left + w) % w + 1, y = (ys[k] - top + h) % h + 1;
        let degree = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
          if ((dx || dy) && cells[(y + dy) * stride + x + dx] === 1) degree++;
        if (degree >= 4) branch++;
        if (degree >= 3) junction++;
      }
    } else if (!closed) continue;
    const curve = Math.max(cw, ch) >= 7 && branch / tail <= 0.1 && junction / tail <= 0.4;
    if (closed || curve) for (let k = 0; k < tail; k++) mask[queue[k]] = 1;
  }
  return mask;
}

/** A field detector followed by palette-component voting. This is not a learned model.
 * Four-neighbour components expose grain which forms one large diagonal network
 * under eight-neighbour labelling. A frozen grain map gates every later edit.
 */
export function cleanGrainRegions(image: IndexedImage, options: CleanupOptions, preserved?: Uint8Array) {
  const { width: w, height: h, pixels: input, palette } = image;
  const n = input.length, level = ['gentle', 'balanced', 'strong'].indexOf(options.strength);
  const pixels = input.slice(), mask = new Uint8Array(n);
  if (!options.flattenTexture) return { pixels, mask, removedPixels: 0, regions: 0 };
  const structure = preserved ?? detectStructureMask(image, options);
  const locked = new Uint8Array(palette.length);
  for (const c of options.protectedColors) locked[c] = 1;
  const outline = options.outlineColor;
  const seen = new Uint8Array(n), queue = new Int32Array(n), grain = new Uint8Array(n);
  const at = (x: number, y: number) => {
    if (x < 0 || x >= w) { if (!options.repeatX) return -1; x = (x % w + w) % w; }
    if (y < 0 || y >= h) { if (!options.repeatY) return -1; y = (y % h + h) % h; }
    return y * w + x;
  };
  const flood = (seed: number, grid: Uint8Array) => {
    queue[0] = seed; seen[seed] = 1;
    let tail = 1;
    for (let head = 0; head < tail; head++) {
      const i = queue[head], x = i % w, y = Math.floor(i / w);
      for (const j of [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)]) {
        if (j >= 0 && !seen[j] && grid[j] === grid[seed]) { seen[j] = 1; queue[tail++] = j; }
      }
    }
    return tail;
  };
  const componentBounds = (count: number) => {
    const xs: number[] = [], ys: number[] = [];
    for (let k = 0; k < count; k++) { xs.push(queue[k] % w); ys.push(Math.floor(queue[k] / w)); }
    const [left, cw] = wrappedExtent(xs, w, options.repeatX), [top, ch] = wrappedExtent(ys, h, options.repeatY);
    return [left, left + cw - 1, top, top + ch - 1];
  };
  // Small fragments, rather than all color transitions, identify the noisy field.
  // Smooth color boundaries and long parallel hatching do not seed it.
  for (let seed = 0; seed < n; seed++) {
    if (seen[seed]) continue;
    const color = input[seed];
    if (color === outline || locked[color] || structure[seed]) { seen[seed] = 1; continue; }
    const count = flood(seed, input);
    if (count > [5, 12, 20][level]) continue;
    const [minX, maxX, minY, maxY] = componentBounds(count);
    if (Math.max(maxX - minX, maxY - minY) > 6) continue;
    const weight = count <= 2 ? 4 : count <= 5 ? 3 : 1;
    for (let k = 0; k < count; k++) grain[queue[k]] = weight;
  }
  const stride = w + 1, integral = new Uint32Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) { sum += grain[y * w + x]; integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum; }
  }
  const radius = [5, 7, 9][level];
  const active = (x: number, y: number) => {
    if (options.repeatX) x = (x % w + w) % w;
    if (options.repeatY) y = (y % h + h) % h;
    if ((options.repeatX && (x - radius < 0 || x + radius >= w)) ||
      (options.repeatY && (y - radius < 0 || y + radius >= h))) {
      let sum = 0, count = 0;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const i = at(x + dx, y + dy); if (i >= 0) { sum += grain[i]; count++; }
      }
      return sum / count >= [0.54, 0.34, 0.22][level];
    }
    const x0 = Math.max(0, x - radius), y0 = Math.max(0, y - radius), x1 = Math.min(w, x + radius + 1), y1 = Math.min(h, y + radius + 1);
    const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
    return sum / ((x1 - x0) * (y1 - y0)) >= [0.54, 0.34, 0.22][level];
  };
  const boundary = new Uint32Array(palette.length), local = new Uint32Array(palette.length);
  const limit = [16, 64, 144][level];
  let regions = 0;
  for (let pass = 0; pass < [2, 3, 4][level]; pass++) {
    const frozen = pixels.slice(); seen.fill(0);
    let passChanges = 0;
    for (let seed = 0; seed < n; seed++) {
      if (seen[seed]) continue;
      const color = frozen[seed];
      if (color === outline || locked[color]) { seen[seed] = 1; continue; }
      const count = flood(seed, frozen);
      if (count > limit) continue;
      let protectedStructure = false;
      for (let k = 0; k < count; k++) if (structure[queue[k]]) { protectedStructure = true; break; }
      if (protectedStructure) continue;
      boundary.fill(0);
      const [minX, maxX, minY, maxY] = componentBounds(count);
      const cx = Math.floor((minX + maxX) / 2), cy = Math.floor((minY + maxY) / 2);
      if (!active(cx, cy)) continue;
      let boundaryCount = 0;
      for (let k = 0; k < count; k++) {
        const i = queue[k], x = i % w, y = Math.floor(i / w);
        for (const j of [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)]) if (j >= 0 && frozen[j] !== color) { boundary[frozen[j]]++; boundaryCount++; }
      }
      let replacement = color;
      for (let c = 0; c < palette.length; c++) if (!locked[c] && boundary[c] > boundary[replacement]) replacement = c;
      if (replacement === color || boundary[replacement] / boundaryCount < [0.94, 0.84, 0.76][level]) continue;
      const cw = maxX - minX + 1, ch = maxY - minY + 1;
      // A filled little motif or a coherent fine stroke is not grain.
      if (count >= 4 && cw >= 2 && ch >= 2 && count / (cw * ch) >= .72 && Math.max(cw / ch, ch / cw) < 3) continue;
      let stroke = false;
      for (let k = 0; k < count && !stroke; k++) {
        const i = queue[k], x = i % w, y = Math.floor(i / w);
        for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
          let run = 0;
          for (let step = -2; step <= 2; step++) { const j = at(x + dx * step, y + dy * step); if (j >= 0 && frozen[j] === color) run++; }
          if (run === 5) { stroke = true; break; }
        }
      }
      if (stroke) continue;
      // Preserve a center enclosed by a thin contrasting rim with a solid exterior.
      const exteriorRays = new Uint8Array(palette.length);
      if (cw <= 12 && ch <= 12) for (const [x, y, dx, dy] of [[minX - 1, cy, -1, 0], [maxX + 1, cy, 1, 0], [cx, minY - 1, 0, -1], [cx, maxY + 1, 0, 1]]) {
        const start = at(x, y); if (start < 0 || frozen[start] !== replacement) continue;
        for (let step = 1; step <= 6; step++) {
          const xx = x + dx * step, yy = y + dy * step, j = at(xx, yy);
          if (j < 0) break;
          if (frozen[j] === replacement) continue;
          let solid = 0;
          for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { const t = at(xx + ox, yy + oy); if (t >= 0 && frozen[t] === frozen[j]) solid++; }
          if (solid >= (frozen[j] === color ? 7 : 5)) { exteriorRays[frozen[j]]++; break; }
        }
      }
      if (exteriorRays.some(rays => rays >= 3)) continue;
      local.fill(0);
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const j = at(cx + dx, cy + dy); if (j >= 0) local[frozen[j]]++;
      }
      if (local[replacement] < local[color] * [1.35, 1.12, 1.04][level]) continue;
      if (replacement === outline) {
        // The same ink can be a contour elsewhere and a broad background here.
        // Only expand it inside a locally dominant field with a solid patch.
        const total = local.reduce((a, b) => a + b, 0);
        if (local[replacement] < total * .55) continue;
        let broad = false;
        for (let k = 0; k < count && !broad; k++) {
          const x = queue[k] % w, y = Math.floor(queue[k] / w);
          for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
            let ink = 0;
            for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
              const j = at(x + dx + ox, y + dy + oy);
              if (j >= 0 && frozen[j] === replacement) ink++;
            }
            if (ink >= 7) { broad = true; break; }
          }
        }
        if (!broad) continue;
      }
      // Resolve a tied boundary using local evidence only; global palette usage
      // never makes a design-wide recoloring decision.
      for (let k = 0; k < count; k++) { pixels[queue[k]] = replacement; mask[queue[k]] = 1; }
      passChanges += count; regions++;
    }
    if (!passChanges) break;
  }
  let removedPixels = 0;
  for (let i = 0; i < n; i++) { mask[i] = pixels[i] !== input[i] ? 1 : 0; removedPixels += mask[i]; }
  return { pixels, mask, removedPixels, regions };
}
