import {
  MAX_OUTPUT_PIXELS, MAX_SIDE, MAX_SOURCE_PIXELS,
  type CleanupOptions, type CleanupResult, type IndexedImage, type Progress,
} from './types';
import { cleanGrainRegions, detectStructureMask } from './texture-cleanup';
import { repairSourceLines } from './line-repair';

/**
 * Palette-first cleanup. All proposals read the same center-nearest raster;
 * a newly filled pixel can never cause another fill in this run.
 * No colors are invented, and protected colors are neither removed nor added.
 */
export function cleanRaster(
  source: IndexedImage,
  options: CleanupOptions,
  onProgress?: (progress: Progress) => void,
): CleanupResult {
  const started = performance.now();
  validate(source, options);
  const { width: w, height: h } = options;
  const n = w * h;
  const sw = source.width, sh = source.height;
  const sx = sw / w, sy = sh / h;
  const paletteSize = source.palette.length;
  const locked = new Uint8Array(paletteSize);
  for (const color of options.protectedColors) locked[color] = 1;
  const outline = options.outlineColor;
  const level = options.strength === 'gentle' ? 0 : options.strength === 'balanced' ? 1 : 2;
  const smallLimit = [1, 2, 4][level];
  const textureLimit = [8, 24, 56][level];
  const maxComponent = options.flattenTexture ? textureLimit : smallLimit;
  const report = (stage: string, percent: number) => onProgress?.({ stage, percent: Math.round(percent * .6) });
  report('Reading the source pixel grid', 3);

  const baseline = new Uint8Array(n);
  const sourceCoverage = new Uint8Array(n);
  const outlineCoverage = new Uint8Array(n);
  const centerX = new Int32Array(w), centerY = new Int32Array(h);
  for (let x = 0; x < w; x++) centerX[x] = Math.min(sw - 1, Math.floor((x + 0.5) * sx));
  for (let y = 0; y < h; y++) centerY[y] = Math.min(sh - 1, Math.floor((y + 0.5) * sy));

  // Exact area support in the original image (not a blurred RGB approximation).
  // Each source cell contributes by its overlap with the target pixel footprint.
  for (let y = 0; y < h; y++) {
    const top = y * sy, bottom = (y + 1) * sy;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const color = source.pixels[centerY[y] * sw + centerX[x]];
      baseline[i] = color;
      const left = x * sx, right = (x + 1) * sx;
      let currentArea = 0, outlineArea = 0;
      for (let yy = Math.floor(top); yy < Math.min(sh, Math.ceil(bottom)); yy++) {
        const wy = Math.min(bottom, yy + 1) - Math.max(top, yy);
        for (let xx = Math.floor(left); xx < Math.min(sw, Math.ceil(right)); xx++) {
          const sample = source.pixels[yy * sw + xx];
          const area = wy * (Math.min(right, xx + 1) - Math.max(left, xx));
          if (sample === color) currentArea += area;
          if (sample === outline) outlineArea += area;
        }
      }
      sourceCoverage[i] = Math.round(255 * currentArea / (sx * sy));
      outlineCoverage[i] = Math.round(255 * outlineArea / (sx * sy));
    }
    if ((y & 127) === 0) report('Measuring original detail', 5 + Math.round(25 * y / h));
  }

  const pixels = baseline.slice();
  const structure = options.flattenTexture ? detectStructureMask({ width: w, height: h, pixels: baseline, palette: source.palette }, options) : new Uint8Array(n);
  const changes = new Uint8Array(n);
  const visited = new Uint8Array(n);
  // One reusable queue, including for large background regions. No per-pixel JS objects.
  const queue = new Int32Array(n);
  const boundary = new Uint32Array(paletteSize);
  const directions = [-1, 0, 1];
  let specksRemoved = 0, texturePixels = 0, gapsRepaired = 0;

  const at = (x: number, y: number): number => {
    if (x < 0 || x >= w) {
      if (!options.repeatX) return -1;
      x = ((x % w) + w) % w;
    }
    if (y < 0 || y >= h) {
      if (!options.repeatY) return -1;
      y = ((y % h) + h) % h;
    }
    return y * w + x;
  };

  // Texture is only nominated inside an active mottled field. Smooth areas and
  // small ornaments beside a designated outline do not satisfy this evidence.
  const textureEvidence = (x: number, y: number): boolean => {
    let transitions = 0, edges = 0, relevant = 0;
    const radius = [4, 5, 6][level];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const i = at(x + dx, y + dy);
        if (i < 0) continue;
        const color = baseline[i];
        if (color === outline || locked[color]) continue;
        relevant++;
        for (const [nx, ny] of [[1, 0], [0, 1]]) {
          const j = at(x + dx + nx, y + dy + ny);
          if (j < 0 || baseline[j] === outline || locked[baseline[j]]) continue;
          edges++;
          if (color !== baseline[j]) transitions++;
        }
      }
    }
    return relevant >= 24 && edges > 0 && transitions / edges >= [0.28, 0.23, 0.19][level];
  };

  // A compact source dot may occupy less than one final cell. Preserve it even
  // when its nearest-neighbour result looks like an isolated pixel.
  const isSourceDetail = (index: number, color: number, forTexture = false): boolean => {
    const x = index % w, y = Math.floor(index / w);
    const cx = centerX[x], cy = centerY[y];
    const reach = forTexture ? 3 : 1.5;
    const rx = Math.max(3, Math.min(32, Math.ceil(sx * reach)));
    const ry = Math.max(3, Math.min(32, Math.ceil(sy * reach)));
    const left = Math.max(0, cx - rx), top = Math.max(0, cy - ry);
    const right = Math.min(sw - 1, cx + rx), bottom = Math.min(sh - 1, cy + ry);
    const bw = right - left + 1, bh = bottom - top + 1;
    const seen = new Uint8Array(bw * bh);
    const pending = new Int32Array(bw * bh);
    let head = 0, tail = 1;
    pending[0] = (cy - top) * bw + cx - left;
    seen[pending[0]] = 1;
    let minX = cx, maxX = cx, minY = cy, maxY = cy, hitsEdge = false;
    while (head < tail) {
      const local = pending[head++];
      const xx = left + local % bw, yy = top + Math.floor(local / bw);
      minX = Math.min(minX, xx); maxX = Math.max(maxX, xx);
      minY = Math.min(minY, yy); maxY = Math.max(maxY, yy);
      for (const dy of directions) for (const dx of directions) {
        if (!dx && !dy) continue;
        const nx = xx + dx, ny = yy + dy;
        if (nx < left || nx > right || ny < top || ny > bottom) {
          // Touching the inspection edge does not imply a continuing stroke:
          // a complete rectangular hatch cell can end exactly on that edge.
          if (nx >= 0 && nx < sw && ny >= 0 && ny < sh && source.pixels[ny * sw + nx] === color) hitsEdge = true;
          continue;
        }
        const next = (ny - top) * bw + nx - left;
        if (!seen[next] && source.pixels[ny * sw + nx] === color) {
          seen[next] = 1; pending[tail++] = next;
        }
      }
    }
    const dotW = maxX - minX + 1, dotH = maxY - minY + 1;
    // A source stroke that leaves the inspection patch is not an isolated speck.
    if (hitsEdge) {
      if (!forTexture) return true;
      let xx = 0, yy = 0, xy = 0;
      for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
        // Examine this connected stroke itself; neighboring parallel hatch
        // cells must not cancel its orientation in the same source patch.
        const gx = seen[y * bw + x + 1] - seen[y * bw + x - 1];
        const gy = seen[(y + 1) * bw + x] - seen[(y - 1) * bw + x];
        xx += gx * gx; yy += gy * gy; xy += gx * gy;
      }
      return xx + yy > 0 && Math.sqrt((xx - yy) ** 2 + 4 * xy * xy) / (xx + yy) >= 0.6;
    }
    const density = tail / (dotW * dotH);
    const solidDot = tail >= 4 && dotW >= 2 && dotH >= 2 &&
      Math.max(dotW / dotH, dotH / dotW) <= 2.8 && density >= 0.6;
    if (forTexture) return dotW >= 2 && dotH >= 2 && density >= 0.82 && tail >= Math.max(6, sx * sy * 0.65);
    const stroke = tail >= 3 && density >= 0.65 &&
      (dotW >= Math.max(3, sx * 1.1) || dotH >= Math.max(3, sy * 1.1));
    const smallRing = tail >= 9 && dotW >= 3 && dotH >= 3;
    return solidDot || stroke || smallRing;
  };

  // A tiny center surrounded by a thin band of another color is an ornament,
  // even when that band is not the designated outline color. Look beyond the
  // immediate boundary so a ring's center is not mistaken for field stippling.
  const isRingCenter = (minX: number, maxX: number, minY: number, maxY: number, rim: number): boolean => {
    if (maxX - minX > 8 || maxY - minY > 8) return false;
    const mx = Math.floor((minX + maxX) / 2), my = Math.floor((minY + maxY) / 2);
    const rays = [[minX - 1, my, -1, 0], [maxX + 1, my, 1, 0],
      [mx, minY - 1, 0, -1], [mx, maxY + 1, 0, 1]];
    const outside = new Uint8Array(paletteSize);
    for (const [x, y, dx, dy] of rays) {
      const first = at(x, y);
      if (first < 0 || baseline[first] !== rim) continue;
      const counted = new Uint8Array(paletteSize);
      for (let step = 1; step <= 6; step++) {
        const next = at(x + dx * step, y + dy * step);
        if (next < 0) break;
        if (baseline[next] !== rim) {
          // The exterior must be a field, not another isolated stipple that
          // happens to fall on the same ray through a noisy region.
          let support = 0;
          for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
            const neighbor = at(x + dx * step + ox, y + dy * step + oy);
            if (neighbor >= 0 && baseline[neighbor] === baseline[next]) support++;
          }
          // Nested ornaments can have a second narrow rim in the center's
          // color. Keep looking for a common exterior beyond either band.
          if (support >= 5 && !counted[baseline[next]]) {
            outside[baseline[next]]++; counted[baseline[next]] = 1;
          }
        }
      }
    }
    return outside.some(count => count >= 3);
  };

  report('Separating details from stray pixels', 32);
  for (let seed = 0; seed < n; seed++) {
    if (visited[seed]) continue;
    const color = baseline[seed];
    if (locked[color]) { visited[seed] = 1; continue; }
    queue[0] = seed; visited[seed] = 1;
    let head = 0, tail = 1;
    while (head < tail) {
      const i = queue[head++], x = i % w, y = Math.floor(i / w);
      for (const dy of directions) for (const dx of directions) {
        if (!dx && !dy) continue;
        const j = at(x + dx, y + dy);
        if (j >= 0 && !visited[j] && baseline[j] === color) {
          visited[j] = 1; queue[tail++] = j;
        }
      }
    }
    if (tail > maxComponent) continue;
    let structured = false;
    for (let k = 0; k < tail; k++) if (structure[queue[k]]) { structured = true; break; }
    if (structured) continue;
    if (options.flattenTexture && color !== outline && isSourceDetail(seed, color, true)) {
      for (let k = 0; k < tail; k++) structure[queue[k]] = 1;
      continue;
    }
    boundary.fill(0);
    let totalBoundary = 0, coverage = 0, nearOutline = false;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    for (let k = 0; k < tail; k++) {
      const i = queue[k], x = i % w, y = Math.floor(i / w);
      coverage += sourceCoverage[i] / 255;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const dy of directions) for (const dx of directions) {
        if (!dx && !dy) continue;
        const j = at(x + dx, y + dy);
        if (j < 0 || baseline[j] === color) continue;
        boundary[baseline[j]]++;
        totalBoundary++;
        if (baseline[j] === outline) nearOutline = true;
      }
    }
    if (!totalBoundary || nearOutline) continue;
    let replacement = color;
    for (let c = 0; c < paletteSize; c++) if (boundary[c] > boundary[replacement]) replacement = c;
    if (replacement === color || locked[replacement] || replacement === outline) continue;
    const agreement = boundary[replacement] / totalBoundary;
    const avgSupport = coverage / tail;
    if (agreement < (options.flattenTexture ? [0.88, 0.8, 0.72][level] : 0.96)) continue;
    if (isRingCenter(minX, maxX, minY, maxY, replacement)) continue;
    const compact = tail >= 4 && tail / ((maxX - minX + 1) * (maxY - minY + 1)) >= 0.6;
    const texture = options.flattenTexture && color !== outline && agreement >= [0.88, 0.8, 0.72][level] &&
      textureEvidence(seed % w, Math.floor(seed / w));
    const stray = tail <= smallLimit && agreement >= 0.96 &&
      avgSupport < [0.42, 0.56, 0.66][level] && !compact && !isSourceDetail(seed, color);
    if (!texture && !stray) continue;
    // A complete, solid small ornament is kept unless there is explicit texture
    // evidence in its field. This is deliberately more cautious than a median filter.
    for (let k = 0; k < tail; k++) {
      pixels[queue[k]] = replacement;
      changes[queue[k]] = texture ? 2 : 1;
    }
    if (texture) texturePixels += tail;
    else specksRemoved++;
    if ((seed & 16383) === 0) report('Cleaning isolated components', 35 + Math.round(35 * seed / n));
  }

  report('Checking line continuity against the source', 73);
  if (outline !== null && !locked[outline] && sx >= 1 && sy >= 1) {
    const pairs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (baseline[i] === outline || locked[baseline[i]] ||
          outlineCoverage[i] < [51, 30, 18][level]) continue;
        let neighbors = 0;
        for (const dy of directions) for (const dx of directions) {
          if (!dx && !dy) continue;
          const j = at(x + dx, y + dy);
          if (j >= 0 && baseline[j] === outline) neighbors++;
        }
        // Keep enclosed holes and do not grow an existing uninterrupted stroke.
        if (neighbors < 2 || neighbors > 4) continue;
        for (const [dx, dy] of pairs) {
          const a = at(x - dx, y - dy), b = at(x + dx, y + dy);
          if (a < 0 || b < 0 || a === b || baseline[a] !== outline || baseline[b] !== outline) continue;
          if (!sourceConnects(source, centerX, centerY, w, a, b, outline, sx, sy, options)) continue;
          // A curve can connect the outline endpoints by going around this
          // cell. Do not fill across a competing perpendicular source path.
          const c = at(x - dy, y + dx), d = at(x + dy, y - dx);
          if (c >= 0 && d >= 0 && c !== d && baseline[c] === baseline[i] && baseline[d] === baseline[i] &&
            sourceConnects(source, centerX, centerY, w, c, d, baseline[i], sx, sy, options, 4)) continue;
          if (changes[i] === 2) texturePixels--;
          pixels[i] = outline; changes[i] = 3; gapsRepaired++;
          break;
        }
      }
      if ((y & 127) === 0) report('Checking line continuity against the source', 75 + Math.round(21 * y / h));
    }
  }

  onProgress?.({ stage: 'Detecting connected grain fields', percent: 61 });
  const grain = cleanGrainRegions({ width: w, height: h, pixels, palette: source.palette }, options, structure);
  for (let i = 0; i < n; i++) if (grain.mask[i]) { pixels[i] = grain.pixels[i]; changes[i] = 2; }
  // Repair from the surviving strokes, so removed texture cannot serve as a new
  // line anchor. Every proposed connection still needs evidence in the original.
  const lines = repairSourceLines(source, { width: w, height: h, pixels, palette: source.palette }, options,
    percent => onProgress?.({ stage: 'Tracing broken lines in every ink', percent: 65 + Math.round(percent * .33) }));
  for (let i = 0; i < n; i++) if (lines.additions[i]) { pixels[i] = lines.pixels[i]; changes[i] = 3; }
  let changedPixels = 0;
  texturePixels = 0; gapsRepaired = 0;
  for (let i = 0; i < n; i++) {
    if (pixels[i] === baseline[i]) { changes[i] = 0; continue; }
    changedPixels++;
    if (changes[i] === 2) texturePixels++;
    if (changes[i] === 3) gapsRepaired++;
  }
  const warnings: string[] = [];
  if (sx > 3 || sy > 3) warnings.push('Details smaller than a final pixel can be lost at this size. Inspect thin strokes and small ornaments at pixel zoom.');
  if (options.flattenTexture) warnings.push('Texture flattening can remove intentional stippling. Review the highlighted changes before exporting.');
  if (outline === null) warnings.push('Select a primary outline ink to enable source-supported repair of short broken lines in every color.');
  if (sx < 1 || sy < 1) warnings.push('This output enlarges at least one axis. Line-gap repair is disabled because enlargement cannot supply missing source detail.');
  if (lines.budgetExhausted) warnings.push('The line-search limit was reached on this dense artwork. Some possible repairs were left unchanged.');
  onProgress?.({ stage: 'Cleanup complete', percent: 100 });
  return {
    image: { width: w, height: h, pixels, palette: source.palette.map(c => [...c]) },
    baseline, changes,
    stats: { changedPixels, specksRemoved, gapsRepaired, texturePixels, repeatedPixels: 0,
      elapsedMs: performance.now() - started, sourceColors: paletteSize,
      linePaths: lines.repairedPaths, grainFragments: grain.regions, lineCandidates: lines.reviewedCandidates },
    warnings,
  };
}

/** Verify an actual same-color path in a bounded source patch, not just nearby ink. */
function sourceConnects(
  source: IndexedImage, cx: Int32Array, cy: Int32Array, width: number,
  a: number, b: number, color: number, sx: number, sy: number, options: CleanupOptions, connectivity: 4 | 8 = 8,
): boolean {
  const ax = cx[a % width], ay = cy[Math.floor(a / width)];
  let bx = cx[b % width], by = cy[Math.floor(b / width)];
  // Put wrapped endpoints in the same local coordinate system.
  if (options.repeatX && Math.abs(bx - ax) > source.width / 2) bx += bx > ax ? -source.width : source.width;
  if (options.repeatY && Math.abs(by - ay) > source.height / 2) by += by > ay ? -source.height : source.height;
  const marginX = Math.max(1, Math.ceil(sx / 2)), marginY = Math.max(1, Math.ceil(sy / 2));
  let left = Math.min(ax, bx) - marginX, right = Math.max(ax, bx) + marginX;
  let top = Math.min(ay, by) - marginY, bottom = Math.max(ay, by) + marginY;
  if (!options.repeatX) { left = Math.max(0, left); right = Math.min(source.width - 1, right); }
  if (!options.repeatY) { top = Math.max(0, top); bottom = Math.min(source.height - 1, bottom); }
  const bw = right - left + 1, bh = bottom - top + 1;
  // Extremely aggressive downscales cannot justify a local one-pixel repair.
  if (bw * bh > 4096) return false;
  const visited = new Uint8Array(bw * bh), queue = new Int32Array(bw * bh);
  const start = (ay - top) * bw + ax - left, target = (by - top) * bw + bx - left;
  visited[start] = 1; queue[0] = start;
  let head = 0, tail = 1;
  while (head < tail) {
    const p = queue[head++];
    if (p === target) return true;
    const px = p % bw, py = Math.floor(p / bw);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      if (connectivity === 4 && dx && dy) continue;
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || nx >= bw || ny < 0 || ny >= bh) continue;
      const j = ny * bw + nx;
      if (visited[j]) continue;
      const xx = ((left + nx) % source.width + source.width) % source.width;
      const yy = ((top + ny) % source.height + source.height) % source.height;
      if (source.pixels[yy * source.width + xx] === color) {
        visited[j] = 1; queue[tail++] = j;
      }
    }
  }
  return false;
}

function validate(source: IndexedImage, options: CleanupOptions): void {
  for (const [name, width, height, limit] of [
    ['Source', source.width, source.height, MAX_SOURCE_PIXELS],
    ['Output', options.width, options.height, MAX_OUTPUT_PIXELS],
  ] as const) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_SIDE || height > MAX_SIDE || width * height > limit)
      throw new Error(`${name} dimensions exceed the supported pixel limits.`);
  }
  if (source.pixels.length !== source.width * source.height) throw new Error('Source pixel data does not match its dimensions.');
  if (!source.palette.length || source.palette.length > 256 || source.palette.some(c =>
    c.length !== 3 || c.some(v => !Number.isInteger(v) || v < 0 || v > 255)))
    throw new Error('The source must have a valid palette with 1 to 256 colors.');
  for (const color of source.pixels) if (color >= source.palette.length) throw new Error('Source contains an invalid palette index.');
  const validIndex = (c: number) => Number.isInteger(c) && c >= 0 && c < source.palette.length;
  if (options.protectedColors.some(c => !validIndex(c)) ||
    (options.outlineColor !== null && !validIndex(options.outlineColor)))
    throw new Error('An outline or protected color is outside the source palette.');
  if (!['gentle', 'balanced', 'strong'].includes(options.strength)) throw new Error('Choose a supported cleanup strength.');
  if (![options.read, options.pick].every(v => Number.isFinite(v) && v > 0 && v <= 10000))
    throw new Error('Read and pick must be positive finite values no greater than 10000.');
}
