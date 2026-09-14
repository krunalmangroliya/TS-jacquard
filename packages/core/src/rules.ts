import type { Palette, Repeat, RuleConfig, Vec2 } from './types';
import { DEFAULT_RULES, MAX_COLORS } from './types';

export const RULE_BITS = { connectVisibleEdges4: 1, minThickness: 2, minRegion: 4, removeCheckerboard: 8 } as const;
export interface RulesResult {
  grid: Uint8Array;
  changedPixelsByRule: Record<string, number>;
  changedPixelsMask: Uint8Array;
  smallRegionsRemoved: Vec2[];
  warnings: string[];
}

export function validateRuleGrid(grid: Uint8Array, w: number, h: number, palette: Palette): void {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 || w * h > 100_000_000 || grid.length !== w * h) {
    throw new Error('Grid dimensions must be positive integers, match its buffer, and contain at most 100 million pixels.');
  }
  if (palette.entries.length < 1 || palette.entries.length > MAX_COLORS || palette.entries.some((p, i) => p.index !== i)) {
    throw new Error('Palette must contain 1–6 contiguous indices beginning at 0.');
  }
  for (const color of grid) if (color >= palette.entries.length) throw new Error(`Pixel color ${color} is outside the palette.`);
}

interface Components { labels: Int32Array; order: Int32Array; starts: number[]; sizes: number[] }

/** Snapshot-based cleanup. The input, visible mask, and configuration are never mutated. */
export function applyRules(
  input: Uint8Array, w: number, h: number, palette: Palette, cfg: RuleConfig = DEFAULT_RULES,
  visibleMask: Uint8Array = new Uint8Array(input.length), repeat: Repeat = { type: 'straight' }, overrideMask: Uint8Array = new Uint8Array(input.length),
): RulesResult {
  validateRuleGrid(input, w, h, palette);
  if (visibleMask.length !== input.length || overrideMask.length !== input.length) throw new Error('Rule masks must match the grid.');
  if (!Number.isSafeInteger(cfg.minRegionPx) || cfg.minRegionPx < 0 || !Number.isSafeInteger(cfg.minThicknessPx) || cfg.minThicknessPx < 0 || cfg.minThicknessPx > 32) {
    throw new Error('Rule thresholds must be nonnegative integers; minThicknessPx must be at most 32.');
  }
  if (cfg.protectedColorIndices?.some(color => !Number.isInteger(color) || color < 0 || color >= palette.entries.length)) throw new Error('Protected colors must be valid palette indices.');
  const n = input.length, periodic = repeat.type === 'straight';
  let grid: Uint8Array = input.slice();
  const visible = visibleMask.slice(), protectedColors = new Set(cfg.protectedColorIndices ?? []), preservedRegionMask = new Uint8Array(n);
  const changedPixelsMask = new Uint8Array(n);
  const changedPixelsByRule: Record<string, number> = Object.fromEntries(Object.keys(RULE_BITS).map(name => [name, 0]));
  const smallRegionsRemoved: Vec2[] = [];
  const warnings = repeat.type === 'half-drop' || repeat.type === 'brick' ? [`${repeat.type} repeat cleanup uses clipped boundaries; staggered seam cleanup is not implemented.`] : [];
  const at = (x: number, y: number): number => {
    if (periodic) return ((y % h + h) % h) * w + ((x % w + w) % w);
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x;
  };
  const immutable = (p: number, source: Uint8Array): boolean => !!visible[p] || !!preservedRegionMask[p] || !!overrideMask[p] || protectedColors.has(source[p]);
  const neighbors4 = (p: number): number[] => {
    const x = p % w, y = Math.floor(p / w);
    return [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
  };
  const components = (source: Uint8Array): Components => {
    const labels = new Int32Array(n).fill(-1), order = new Int32Array(n), starts: number[] = [], sizes: number[] = [];
    let tail = 0;
    for (let p = 0; p < n; p++) {
      if (labels[p] !== -1) continue;
      const id = starts.length, start = tail;
      starts.push(start); labels[p] = id; order[tail++] = p;
      for (let head = start; head < tail; head++) {
        const q = order[head], x = q % w, color = source[p];
        // Avoid allocating a neighbor array for every pixel in large loom grids.
        let r = x > 0 ? q - 1 : periodic ? q + w - 1 : -1;
        if (r >= 0 && labels[r] === -1 && source[r] === color) { labels[r] = id; order[tail++] = r; }
        r = x + 1 < w ? q + 1 : periodic ? q - w + 1 : -1;
        if (r >= 0 && labels[r] === -1 && source[r] === color) { labels[r] = id; order[tail++] = r; }
        r = q >= w ? q - w : periodic ? q + n - w : -1;
        if (r >= 0 && labels[r] === -1 && source[r] === color) { labels[r] = id; order[tail++] = r; }
        r = q + w < n ? q + w : periodic ? q + w - n : -1;
        if (r >= 0 && labels[r] === -1 && source[r] === color) { labels[r] = id; order[tail++] = r; }
      }
      sizes.push(tail - start);
    }
    return { labels, order, starts, sizes };
  };
  const mostFrequent = (counts: Int32Array, fallback: number): number => {
    let best = fallback, count = 0;
    for (let color = 0; color < counts.length; color++) if (counts[color] > count) { best = color; count = counts[color]; }
    return best;
  };
  const finish = (name: keyof typeof RULE_BITS, next: Uint8Array): void => {
    let count = 0;
    for (let p = 0; p < n; p++) if (next[p] !== grid[p] && !overrideMask[p]) { count++; changedPixelsMask[p] |= RULE_BITS[name]; }
    changedPixelsByRule[name] = count; grid = next;
  };

  if (cfg.connectVisibleEdges4 && w > 1 && h > 1 && visible.some(Boolean)) {
    const source = grid, next = source.slice(), snapshotVisible = visible.slice(), cc = components(source), proposed = new Uint8Array(n);
    const bridge = (a: number, b: number, candidate1: number, candidate2: number): void => {
      const color = source[a];
      if (!snapshotVisible[a] || !snapshotVisible[b] || source[b] !== color || source[candidate1] === color || source[candidate2] === color) return;
      let first = candidate1, second = candidate2;
      if (cc.sizes[cc.labels[second]] > cc.sizes[cc.labels[first]]) [first, second] = [second, first];
      const target = !immutable(first, source) && !proposed[first] ? first : !immutable(second, source) && !proposed[second] ? second : -1;
      if (target < 0) return;
      next[target] = color; proposed[target] = 1;
    };
    for (let y = 0; y < (periodic ? h : h - 1); y++) for (let x = 0; x < (periodic ? w : w - 1); x++) {
      const a = at(x, y), b = at(x + 1, y), c = at(x, y + 1), d = at(x + 1, y + 1);
      bridge(a, d, b, c); bridge(b, c, a, d);
    }
    for (let p = 0; p < n; p++) if (proposed[p]) visible[p] = 1;
    finish('connectVisibleEdges4', next);
  }

  if (cfg.minThicknessPx > 1) {
    const k = cfg.minThicknessPx, low = -Math.floor(k / 2), high = low + k - 1, source = grid, next = source.slice();
    const eroded = new Uint8Array(n).fill(255);
    for (let p = 0; p < n; p++) {
      const x = p % w, y = Math.floor(p / w), color = source[p];
      let full = true;
      for (let dy = low; dy <= high && full; dy++) for (let dx = low; dx <= high; dx++) {
        const q = at(x + dx, y + dy);
        if (q < 0 || source[q] !== color) { full = false; break; }
      }
      if (full) eroded[p] = color;
    }
    for (let p = 0; p < n; p++) {
      if (immutable(p, source)) continue;
      const x = p % w, y = Math.floor(p / w), color = source[p];
      let survives = false;
      for (let dy = low; dy <= high && !survives; dy++) for (let dx = low; dx <= high; dx++) {
        const q = at(x - dx, y - dy);
        if (q >= 0 && eroded[q] === color) { survives = true; break; }
      }
      if (survives) continue;
      const counts = new Int32Array(palette.entries.length);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const q = at(x + dx, y + dy);
        if (q >= 0 && source[q] !== color) counts[source[q]]++;
      }
      next[p] = mostFrequent(counts, color);
    }
    finish('minThickness', next);
  }

  if (cfg.minRegionPx > 1) {
    const source = grid, next = source.slice(), cc = components(source);
    // Small 4-connected islands can be samples of one substantial diagonal
    // motif. Search their component graph only up to the deletion threshold.
    const aggregateState = new Uint8Array(cc.starts.length); // 1 = substantial, 2 = truly small
    const belongsToLargerDiagonalRegion = (id: number): boolean => {
      if (aggregateState[id]) return aggregateState[id] === 1;
      const visited = new Set<number>([id]), queue = [id];
      let total = cc.sizes[id], substantial = total >= cfg.minRegionPx;
      for (let head = 0; head < queue.length && !substantial; head++) {
        const current = queue[head], start = cc.starts[current];
        for (let i = start; i < start + cc.sizes[current] && !substantial; i++) {
          const p = cc.order[i], x = p % w, y = Math.floor(p / w);
          for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const q = at(x + dx, y + dy);
            if (q < 0 || source[q] !== source[p]) continue;
            const other = cc.labels[q];
            if (visited.has(other)) continue;
            visited.add(other);
            total += cc.sizes[other];
            if (aggregateState[other] === 1 || total >= cfg.minRegionPx) { substantial = true; break; }
            queue.push(other);
          }
        }
      }
      for (const component of visited) aggregateState[component] = substantial ? 1 : 2;
      return substantial;
    };
    let deferredComponents = 0;
    for (let id = 0; id < cc.starts.length; id++) {
      const start = cc.starts[id], size = cc.sizes[id];
      if (size >= cfg.minRegionPx) continue;
      let protectedComponent = false;
      for (let i = start; i < start + size; i++) if (immutable(cc.order[i], source)) { protectedComponent = true; break; }
      if (protectedComponent) continue;
      if (belongsToLargerDiagonalRegion(id)) {
        deferredComponents++;
        // Keep the same safeguard during the subsequent checkerboard pass.
        for (let i = start; i < start + size; i++) preservedRegionMask[cc.order[i]] = 1;
        continue;
      }
      const border = new Set<number>(), counts = new Int32Array(palette.entries.length);
      for (let i = start; i < start + size; i++) for (const q of neighbors4(cc.order[i])) if (q >= 0 && cc.labels[q] !== id) border.add(q);
      for (const q of border) counts[source[q]]++;
      const color = source[cc.order[start]], replacement = mostFrequent(counts, color);
      if (replacement === color) continue;
      let x = 0, y = 0;
      for (let i = start; i < start + size; i++) { const p = cc.order[i]; next[p] = replacement; x += p % w + 0.5; y += Math.floor(p / w) + 0.5; }
      // A location on the actual component is more useful than a centroid across a wrapped seam.
      const first = cc.order[start];
      smallRegionsRemoved.push(periodic ? { x: first % w + 0.5, y: Math.floor(first / w) + 0.5 } : { x: x / size, y: y / size });
    }
    if (deferredComponents) warnings.push(`Preserved ${deferredComponents} small component(s) belonging to larger diagonal regions; review their connectivity at this size.`);
    finish('minRegion', next);
  }

  if (cfg.removeCheckerboard && w > 1 && h > 1) {
    const source = grid, next = source.slice(), proposed = new Uint8Array(n);
    for (let y = 0; y < (periodic ? h : h - 1); y++) for (let x = 0; x < (periodic ? w : w - 1); x++) {
      const p = y * w + x, right = x + 1 < w ? p + 1 : p - w + 1, bottom = y + 1 < h ? p + w : x;
      const a = source[p], b = source[right];
      if (a === b || b !== source[bottom]) continue;
      const diagonal = x + 1 < w ? bottom + 1 : bottom - w + 1;
      if (a !== source[diagonal]) continue;
      const points = [p, right, bottom, diagonal];
      const border = new Set<number>();
      for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) {
        const p = at(x + dx, y + dy);
        if (p >= 0 && !points.includes(p)) border.add(p);
      }
      let aCount = 0, bCount = 0;
      for (const p of border) { if (source[p] === a) aCount++; else if (source[p] === b) bCount++; }
      const winner = aCount > bCount ? a : bCount > aCount ? b : Math.min(a, b);
      for (const p of points) if (source[p] !== winner && !immutable(p, source) && !proposed[p]) { next[p] = winner; proposed[p] = 1; }
    }
    finish('removeCheckerboard', next);
  }
  return { grid, changedPixelsByRule, changedPixelsMask, smallRegionsRemoved, warnings };
}
