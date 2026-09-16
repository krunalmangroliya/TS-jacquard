import { MAX_OUTPUT_PIXELS, MAX_SIDE, type CleanupOptions, type IndexedImage } from './types';

export const AI_PATCH_SIDE = 64;
export const AI_CORE_SIDE = 32;
export const AI_HALO = 16;
export const AI_MAX_PATCHES = 128;
const PATCH_PIXELS = AI_PATCH_SIDE * AI_PATCH_SIDE;
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
type AiOptions = Pick<CleanupOptions, 'protectedColors' | 'repeatX' | 'repeatY' | 'outlineColor' | 'strength'>;
export interface AiPatch {
  id: number;
  color: number;
  /** Top-left of the full 64-square patch; may be negative. Only its central 32-square core is writable. */
  x: number;
  y: number;
  mask: Float32Array;
  score: number;
  /** Bit 1: small component, bit 2: facing stroke ends, bit 4: small enclosed region. */
  reasons: number;
}
export interface AiCoverage {
  totalPixels: number;
  scannedPixels: number;
  candidatePatches: number;
  selectedPatches: number;
  /** Unique, valid image pixels in the selected cores, not multiplied by palette colors. */
  inferredCorePixels: number;
  scanLimited: boolean;
  patchLimited: boolean;
  /** Aliases used by the experiment UI. */
  eligiblePatches: number;
  candidatePixels: number;
  limited: boolean;
}
export interface AiPatchLimits { maxPatches?: number; maxScannedPixels?: number }
export interface AiPrediction { patch: AiPatch; logits: Float32Array }
export interface AiThresholds { add: number; remove: number; margin?: number }
export interface AiApplyLimits { maxGeometryCells?: number }
export interface AiApplyStats {
  predictions: number;
  confidentPixels: number;
  proposedPixels: number;
  addedPixels: number;
  removedPixels: number;
  conflictPixels: number;
  geometryRejected: number;
  geometryCells: number;
  geometryBudgetExhausted: boolean;
}
export interface AiApplication {
  image: IndexedImage;
  /** 0 unchanged, 1 learned removal, 2 learned addition; the experiment UI maps additions to its green legend. */
  changes: Uint8Array;
  stats: AiApplyStats;
}

function validate(image: IndexedImage, options: AiOptions) {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > MAX_SIDE || image.height > MAX_SIDE || image.width * image.height > MAX_OUTPUT_PIXELS || image.pixels.length !== image.width * image.height) throw new Error('AI cleanup dimensions exceed the supported output grid.');
  if (!image.palette.length || image.palette.length > 256 || image.palette.some(c => c.length !== 3 || c.some(v => !Number.isInteger(v) || v < 0 || v > 255))) throw new Error('AI cleanup needs an indexed RGB palette.');
  const validColor = (c: number) => Number.isInteger(c) && c >= 0 && c < image.palette.length;
  if (options.protectedColors.some(c => !validColor(c)) || (options.outlineColor !== null && !validColor(options.outlineColor))) throw new Error('AI cleanup has an invalid ink selection.');
  for (const color of image.pixels) if (!validColor(color)) throw new Error('AI cleanup received an invalid pixel index.');
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('AI cleanup budget is outside its supported limit.');
  return value;
}
function access(image: IndexedImage, options: AiOptions) {
  const { width: w, height: h } = image;
  return (x: number, y: number): number => {
    if (x < 0 || x >= w) { if (!options.repeatX) return -1; x = (x % w + w) % w; }
    if (y < 0 || y >= h) { if (!options.repeatY) return -1; y = (y % h + h) % h; }
    return y * w + x;
  };
}
function endpoint(image: IndexedImage, at: (x: number, y: number) => number, x: number, y: number, color: number, awayX: number, awayY: number): boolean {
  let count = 0, sumX = 0, sumY = 0;
  for (const [dx, dy] of DIRECTIONS) {
    const j = at(x + dx, y + dy);
    if (j >= 0 && image.pixels[j] === color) { count++; sumX += dx; sumY += dy; }
  }
  return count > 0 && count <= 4 && (sumX * awayX + sumY * awayY) / Math.hypot(awayX, awayY) >= count * .55;
}

/** Palette-neutral, deterministic sampling. The model sees actual canvas pixels, never a synthetic prediction. */
export function generateAiPatches(image: IndexedImage, options: AiOptions, limits: AiPatchLimits = {}): { patches: AiPatch[]; coverage: AiCoverage } {
  validate(image, options);
  const n = image.pixels.length, w = image.width, h = image.height, colors = image.palette.length;
  const maxPatches = bounded(limits.maxPatches, 32, AI_MAX_PATCHES);
  const scanned = Math.min(n, bounded(limits.maxScannedPixels, Math.min(n, 1_000_000), MAX_OUTPUT_PIXELS));
  const columns = Math.ceil(w / AI_CORE_SIDE), rows = Math.ceil(h / AI_CORE_SIDE);
  // At the maximum image and palette sizes these arrays together stay below 11 MB.
  const scores = new Float32Array(columns * rows * colors), reasons = new Uint8Array(scores.length);
  const visited = new Uint8Array(n), locked = new Set(options.protectedColors), at = access(image, options);
  const queue = new Int32Array(18);
  const offer = (index: number, color: number, value: number, reason: number) => {
    if (locked.has(color)) return;
    const tile = Math.floor(Math.floor(index / w) / AI_CORE_SIDE) * columns + Math.floor((index % w) / AI_CORE_SIDE);
    const key = tile * colors + color;
    scores[key] += value; reasons[key] |= reason;
  };
  for (let sample = 0; sample < scanned; sample++) {
    // Stratification covers the whole image instead of silently stopping at the top-left corner.
    const i = Math.floor(sample * n / scanned), x = i % w, y = Math.floor(i / w), color = image.pixels[i];
    if (locked.has(color)) continue;
    if (!visited[i]) {
      let head = 0, tail = 1, overflow = false; queue[0] = i; visited[i] = 2;
      while (head < tail && !overflow) {
        const j = queue[head++], px = j % w, py = Math.floor(j / w);
        for (const d of [0, 2, 4, 6]) {
          const [dx, dy] = DIRECTIONS[d], k = at(px + dx, py + dy);
          if (k < 0 || image.pixels[k] !== color) continue;
          if (visited[k] === 1) { overflow = true; break; }
          if (visited[k]) continue;
          visited[k] = 2;
          if (tail === queue.length) { visited[k] = 1; overflow = true; break; }
          queue[tail++] = k;
        }
      }
      for (let q = 0; q < tail; q++) visited[queue[q]] = overflow ? 1 : 3;
      if (!overflow && tail <= 16) {
        for (let q = 0; q < tail; q++) offer(queue[q], color, 4 / Math.sqrt(tail), 1);
        if (tail <= 4) {
          const neighborColors = new Set<number>(); let boundary = false;
          for (let q = 0; q < tail; q++) {
            const j = queue[q];
            for (const d of [0, 2, 4, 6]) {
              const [dx, dy] = DIRECTIONS[d], k = at(j % w + dx, Math.floor(j / w) + dy);
              if (k < 0) boundary = true;
              else if (image.pixels[k] !== color) neighborColors.add(image.pixels[k]);
            }
          }
          if (!boundary && neighborColors.size === 1) offer(i, neighborColors.values().next().value!, 2, 4);
        }
      }
    }
    if (options.outlineColor === null) continue;
    for (const [dx, dy] of DIRECTIONS) {
      const next = at(x + dx, y + dy);
      if (next < 0 || image.pixels[next] === color || locked.has(image.pixels[next]) || !endpoint(image, at, x, y, color, -dx, -dy)) continue;
      const gapColor = image.pixels[next];
      for (let distance = 2; distance <= 4; distance++) {
        const j = at(x + dx * distance, y + dy * distance);
        if (j < 0) break;
        if (image.pixels[j] === color) {
          if (endpoint(image, at, x + dx * distance, y + dy * distance, color, dx, dy)) {
            for (let k = 1; k < distance; k++) offer(at(x + dx * k, y + dy * k), color, 8 / (distance - 1), 2);
          }
          break;
        }
        if (image.pixels[j] !== gapColor) break;
      }
    }
  }
  // Bounded top-k insertion avoids retaining a JS object for every palette/tile pair.
  const best: number[] = []; let candidates = 0;
  for (let key = 0; key < scores.length; key++) {
    if (!scores[key]) continue;
    candidates++;
    if (!maxPatches) continue;
    let low = 0, high = best.length;
    while (low < high) { const mid = (low + high) >>> 1; if (scores[key] > scores[best[mid]] || (scores[key] === scores[best[mid]] && key < best[mid])) high = mid; else low = mid + 1; }
    if (low < maxPatches) { best.splice(low, 0, key); if (best.length > maxPatches) best.pop(); }
  }
  const selectedTiles = new Set<number>(); let inferredCorePixels = 0;
  const patches = best.map(id => {
    const color = id % colors, tile = Math.floor(id / colors), coreX = tile % columns * AI_CORE_SIDE, coreY = Math.floor(tile / columns) * AI_CORE_SIDE;
    if (!selectedTiles.has(tile)) { selectedTiles.add(tile); inferredCorePixels += Math.min(AI_CORE_SIDE, w - coreX) * Math.min(AI_CORE_SIDE, h - coreY); }
    const x = coreX - AI_HALO, y = coreY - AI_HALO, mask = new Float32Array(PATCH_PIXELS);
    for (let py = 0; py < AI_PATCH_SIDE; py++) for (let px = 0; px < AI_PATCH_SIDE; px++) {
      // A non-repeating outer border is extended, not interpreted as invented empty ink.
      const sx = options.repeatX ? x + px : Math.max(0, Math.min(w - 1, x + px));
      const sy = options.repeatY ? y + py : Math.max(0, Math.min(h - 1, y + py));
      mask[py * AI_PATCH_SIDE + px] = image.pixels[at(sx, sy)] === color ? 1 : 0;
    }
    return { id, color, x, y, mask, score: scores[id], reasons: reasons[id] };
  });
  return { patches, coverage: { totalPixels: n, scannedPixels: scanned, candidatePatches: candidates, selectedPatches: patches.length, inferredCorePixels, scanLimited: scanned < n, patchLimited: patches.length < candidates, eligiblePatches: candidates, candidatePixels: inferredCorePixels, limited: scanned < n || patches.length < candidates } };
}

/** Apply actual model logits using the unchanged canvas as the sole geometric reference. */
export function applyAiPredictions(image: IndexedImage, options: AiOptions, predictions: AiPrediction[], thresholds: AiThresholds, limits: AiApplyLimits = {}): AiApplication {
  validate(image, options);
  const margin = thresholds.margin ?? .04;
  if (![thresholds.add, thresholds.remove].every(v => Number.isFinite(v) && v >= .5 && v <= 1) || !Number.isFinite(margin) || margin < 0 || margin > 1) throw new Error('AI confidence thresholds must be valid probabilities.');
  if (predictions.length > AI_MAX_PATCHES) throw new Error('AI prediction batch exceeds the patch budget.');
  const geometryLimit = bounded(limits.maxGeometryCells, 1_000_000, 4_000_000);
  const n = image.pixels.length, w = image.width, h = image.height, pixels = image.pixels.slice(), changes = new Uint8Array(n), at = access(image, options), locked = new Set(options.protectedColors);
  const stats: AiApplyStats = { predictions: predictions.length, confidentPixels: 0, proposedPixels: 0, addedPixels: 0, removedPixels: 0, conflictPixels: 0, geometryRejected: 0, geometryCells: 0, geometryBudgetExhausted: false };
  type Proposal = { color: number; probability: number; kind: 1 | 2 };
  const proposals = new Map<number, Map<number, Proposal>>();
  const structureCache = new Uint8Array(n), componentCache = new Map<number, number[]>();
  const sigmoid = (v: number) => v >= 0 ? 1 / (1 + Math.exp(-v)) : Math.exp(v) / (1 + Math.exp(v));
  const spend = () => { if (stats.geometryCells >= geometryLimit) { stats.geometryBudgetExhausted = true; return false; } stats.geometryCells++; return true; };
  const component = (seed: number, diagonal: boolean, cap: number): number[] | null => {
    const color = image.pixels[seed], list = [seed], seen = new Set([seed]);
    for (let head = 0; head < list.length; head++) {
      if (!spend()) return null;
      const j = list[head], x = j % w, y = Math.floor(j / w);
      for (let d = 0; d < 8; d += diagonal ? 1 : 2) {
        const [dx, dy] = DIRECTIONS[d], k = at(x + dx, y + dy);
        if (k < 0 || seen.has(k) || image.pixels[k] !== color) continue;
        if (list.length === cap) return null;
        seen.add(k); list.push(k);
      }
    }
    return list;
  };
  const protectedStructure = (seed: number): boolean => {
    if (structureCache[seed]) return structureCache[seed] === 2;
    const list = component(seed, true, 128);
    if (!list) { structureCache[seed] = 2; return true; }
    const originX = seed % w, originY = Math.floor(seed / w);
    const unwrap = (v: number, origin: number, size: number, repeat: boolean) => repeat ? origin + ((v - origin + Math.floor(size / 2)) % size + size) % size - Math.floor(size / 2) : v;
    const points = list.map(j => [unwrap(j % w, originX, w, options.repeatX), unwrap(Math.floor(j / w), originY, h, options.repeatY)]);
    const left = Math.min(...points.map(p => p[0])), right = Math.max(...points.map(p => p[0])), top = Math.min(...points.map(p => p[1])), bottom = Math.max(...points.map(p => p[1]));
    const bw = right - left + 3, bh = bottom - top + 3;
    let protect = bw > 34 || bh > 34 || (list.length >= 4 && list.length / ((bw - 2) * (bh - 2)) >= .8);
    // Four-connected exterior flood recognizes diagonal closed rings too.
    if (!protect) {
      const occupied = new Uint8Array(bw * bh), exterior = new Uint8Array(bw * bh), queue = [0]; exterior[0] = 1;
      for (const [x, y] of points) occupied[(y - top + 1) * bw + x - left + 1] = 1;
      for (let head = 0; head < queue.length; head++) {
        const j = queue[head], x = j % bw, y = Math.floor(j / bw);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, k = ny * bw + nx;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh || occupied[k] || exterior[k]) continue;
          exterior[k] = 1; queue.push(k);
        }
      }
      protect = occupied.some((ink, j) => !ink && !exterior[j]);
      if (!protect && Math.max(bw - 2, bh - 2) >= 5) {
        let branches = 0;
        const members = new Set(list);
        for (const j of list) {
          let count = 0;
          for (const [dx, dy] of DIRECTIONS) if (members.has(at(j % w + dx, Math.floor(j / w) + dy))) count++;
          if (count > 3) branches++;
        }
        protect = branches / list.length < .25;
      }
    }
    for (const j of list) structureCache[j] = protect ? 2 : 1;
    return protect;
  };
  const smallRemoval = (seed: number): number[] | null => {
    const cached = componentCache.get(seed); if (cached) return cached;
    const list = component(seed, false, options.strength === 'gentle' ? 8 : options.strength === 'strong' ? 32 : 16);
    if (list) for (const j of list) componentCache.set(j, list);
    return list;
  };
  const canAdd = (index: number, color: number): boolean => {
    if (options.outlineColor === null) return false;
    const old = image.pixels[index], x = index % w, y = Math.floor(index / w);
    // A small existing enclosed region is a hole/dot, not evidence of a broken line.
    const oldComponent = component(index, false, 16);
    if (stats.geometryBudgetExhausted) return false;
    if (oldComponent && oldComponent.every(j => {
      for (const d of [0, 2, 4, 6]) { const [dx, dy] = DIRECTIONS[d], k = at(j % w + dx, Math.floor(j / w) + dy); if (k < 0 || (image.pixels[k] !== old && image.pixels[k] !== color)) return false; }
      return true;
    })) return false;
    let sameNeighbors = 0;
    for (const [dx, dy] of DIRECTIONS) { const j = at(x + dx, y + dy); if (j >= 0 && image.pixels[j] === old) sameNeighbors++; }
    // A third ink already crossing this gap must not be cut by a learned connection.
    if (sameNeighbors <= 3) for (let d = 0; d < 4; d++) {
      const [dx, dy] = DIRECTIONS[d], a = at(x + dx, y + dy), b = at(x - dx, y - dy);
      if (a >= 0 && b >= 0 && a !== b && image.pixels[a] === old && image.pixels[b] === old) return false;
    }
    const anchors: Array<{ dx: number; dy: number; distance: number; index: number }> = [];
    for (const [dx, dy] of DIRECTIONS) for (let distance = 1; distance <= 3; distance++) {
      const j = at(x + dx * distance, y + dy * distance);
      if (j < 0) break;
      if (image.pixels[j] === color) {
        if (endpoint(image, at, x + dx * distance, y + dy * distance, color, dx, dy)) anchors.push({ dx, dy, distance, index: j });
        break;
      }
      if (image.pixels[j] !== old) break;
    }
    return anchors.some((a, k) => anchors.slice(k + 1).some(b => a.index !== b.index && a.distance + b.distance <= 4 && a.dx * b.dx + a.dy * b.dy <= -.5 * Math.hypot(a.dx, a.dy) * Math.hypot(b.dx, b.dy)));
  };
  const offer = (index: number, color: number, probability: number, kind: 1 | 2) => {
    let colors = proposals.get(index); if (!colors) { colors = new Map(); proposals.set(index, colors); }
    const old = colors.get(color);
    if (!old || old.probability < probability || (old.probability === probability && kind === 2)) colors.set(color, { color, probability, kind });
  };
  const removeLogit = Math.log(thresholds.remove / (1 - thresholds.remove)), addLogit = Math.log(thresholds.add / (1 - thresholds.add));
  const predictedRemoval = new Map<number, number>();
  // Sort to make the geometry work cap and tie handling independent of inference completion order.
  const ordered = [...predictions].sort((a, b) => a.patch.id - b.patch.id || a.patch.color - b.patch.color);
  for (const { patch, logits } of ordered) {
    if (!Number.isInteger(patch.x) || !Number.isInteger(patch.y) || !Number.isInteger(patch.color) || patch.color < 0 || patch.color >= image.palette.length || logits.length !== PATCH_PIXELS * 2 || patch.mask.length !== PATCH_PIXELS || (patch.x + AI_HALO) % AI_CORE_SIDE !== 0 || (patch.y + AI_HALO) % AI_CORE_SIDE !== 0) throw new Error('AI prediction has an invalid patch shape or grid.');
    if (locked.has(patch.color)) continue;
    for (let py = AI_HALO; py < AI_HALO + AI_CORE_SIDE; py++) for (let px = AI_HALO; px < AI_HALO + AI_CORE_SIDE; px++) {
      const x = patch.x + px, y = patch.y + py;
      // Halos wrap, but each valid center pixel is owned by exactly one core tile.
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x, old = image.pixels[i], p = py * AI_PATCH_SIDE + px;
      if (locked.has(old)) continue;
      if (old === patch.color) {
        const value = logits[PATCH_PIXELS + p];
        if (Number.isFinite(value) && value >= removeLogit) { stats.confidentPixels++; predictedRemoval.set(i, Math.max(predictedRemoval.get(i) || 0, sigmoid(value))); }
      } else {
        const value = logits[p];
        if (Number.isFinite(value) && value >= addLogit) {
          stats.confidentPixels++;
          if (canAdd(i, patch.color)) offer(i, patch.color, sigmoid(value), 2);
          else stats.geometryRejected++;
        }
      }
    }
  }
  const handledRemoval = new Set<number>();
  for (const [i] of [...predictedRemoval.entries()].sort((a, b) => a[0] - b[0])) {
    if (handledRemoval.has(i)) continue;
    const list = smallRemoval(i);
    if (!list || list.some(j => !predictedRemoval.has(j)) || protectedStructure(i)) { stats.geometryRejected++; continue; }
    const votes = new Uint16Array(image.palette.length), old = image.pixels[i], members = new Set(list);
    for (const j of list) for (const [dx, dy] of DIRECTIONS) {
      const k = at(j % w + dx, Math.floor(j / w) + dy);
      if (k >= 0 && !members.has(k) && image.pixels[k] !== old) votes[image.pixels[k]]++;
    }
    let replacement = -1, total = 0, best = 0;
    for (let color = 0; color < votes.length; color++) { total += votes[color]; if (!locked.has(color) && votes[color] > best) { best = votes[color]; replacement = color; } }
    if (replacement < 0 || best < 4 || best / total < .75) { stats.geometryRejected++; continue; }
    for (const j of list) { handledRemoval.add(j); offer(j, replacement, predictedRemoval.get(j)!, 1); }
  }
  stats.proposedPixels = proposals.size;
  for (const [index, colors] of proposals) {
    const ranked = [...colors.values()].sort((a, b) => b.probability - a.probability || a.color - b.color);
    if (ranked.length > 1 && ranked[0].probability - ranked[1].probability < margin) { stats.conflictPixels++; continue; }
    const winner = ranked[0]; pixels[index] = winner.color; changes[index] = winner.kind;
    if (winner.kind === 2) stats.addedPixels++; else stats.removedPixels++;
  }
  return { image: { ...image, pixels }, changes, stats };
}
