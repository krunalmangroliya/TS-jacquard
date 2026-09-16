import { RasterOutlineEvidence, type OutlinePass, type OutlineRect } from './raster-outline';
import type { RuleConfig } from './types';

const MAX_PATCH = 4096;
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]] as const;
const inside = (r: OutlineRect, x: number, y: number): boolean => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
export interface ConservativeOutlinePasses { preserved?: OutlinePass; repaired?: OutlinePass; conflictingPixels?: number }

/** Bounded proposals from one unmodified sample, followed by a joint detail check. */
export class ConservativeRasterOutline extends RasterOutlineEvidence {
  private labels = new Int32Array(MAX_PATCH);
  private patchQueue = new Int32Array(MAX_PATCH);

  /** Serial color proofs share the frozen sample and keep at most one choice per output cell. */
  planColors(input: Uint8Array, eligible: Uint8Array, immutable: Uint8Array, rules: RuleConfig): ConservativeOutlinePasses {
    if (!this.shrinking) return {};
    const repairs = new Set(rules.repairOutlineGaps ? rules.repairColorIndices : []);
    const colors = new Set(repairs);
    if (rules.rasterResize === 'preserve-outline') colors.add(rules.outlineColorIndex!);
    const targets = new Int16Array(input.length).fill(-1), flags = new Uint8Array(input.length), rejected = new Uint8Array(input.length);
    let preserveSkipped = 0, repairSkipped = 0;
    for (const color of colors) {
      // No result from another ink can become evidence for this one. A local
      // planner's full-grid buffers are released before the next color runs.
      const evidence = new ConservativeRasterOutline(this.source, this.sw, this.sh, this.w, this.h, color);
      const passes = evidence.plan(input, eligible, immutable, { ...rules, outlineColorIndex: color,
        rasterResize: rules.rasterResize === 'preserve-outline' && color === rules.outlineColorIndex ? 'preserve-outline' : 'nearest',
        repairOutlineGaps: repairs.has(color) });
      preserveSkipped += passes.preserved?.skipped ?? 0; repairSkipped += passes.repaired?.skipped ?? 0;
      for (const [bit, pass] of [[1, passes.preserved], [2, passes.repaired]] as const) if (pass) {
        for (let p = 0; p < input.length; p++) if (pass.changed[p]) {
          if (targets[p] === -1 || targets[p] === color) { targets[p] = color; flags[p] |= bit; }
          else { targets[p] = -2; rejected[p] = 1; }
        }
      }
    }
    // Different inks within two cells have overlapping 3×3 detail checks.
    // Abstain at both proposals, including ties, instead of privileging an ink
    // or allowing individually valid changes to undermine each other.
    for (let p = 0; p < input.length; p++) if (targets[p] !== -1) {
      const x = p % this.w, y = Math.floor(p / this.w);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (x + dx < 0 || y + dy < 0 || x + dx >= this.w || y + dy >= this.h) continue;
        const q = p + dy * this.w + dx;
        if (targets[q] === -1 || (targets[p] >= 0 && targets[p] === targets[q])) continue;
        rejected[p] = 1; rejected[q] = 1;
      }
    }
    const makePass = (bit: number, skipped: number): OutlinePass => {
      const pass = { grid: input.slice(), changed: new Uint8Array(input.length), count: 0, skipped };
      for (let p = 0; p < input.length; p++) if (targets[p] >= 0 && !rejected[p] && flags[p] & bit) {
        pass.grid[p] = targets[p]; pass.changed[p] = 1; pass.count++;
      }
      return pass;
    };
    const preserved = rules.rasterResize === 'preserve-outline' ? makePass(1, preserveSkipped) : undefined;
    if (preserved) this.pruneMissedFragments(input, preserved);
    return { preserved, repaired: rules.repairOutlineGaps ? makePass(2, repairSkipped) : undefined, conflictingPixels: rejected.reduce((sum, value) => sum + value, 0) };
  }

  private sourceCenter(x: number, y: number): [number, number] {
    return [Math.min(this.sw - 1, Math.floor((x + 0.5) * this.sw / this.w)), Math.min(this.sh - 1, Math.floor((y + 0.5) * this.sh / this.h))];
  }

  private neighborCount(input: Uint8Array, p: number, color: number, removed?: Uint8Array): number {
    const x = p % this.w, y = Math.floor(p / this.w);
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || x + dx < 0 || y + dy < 0 || x + dx >= this.w || y + dy >= this.h) continue;
      const q = p + dy * this.w + dx;
      if (input[q] === color && !removed?.[q]) count++;
    }
    return count;
  }

  private anchoredConnection(x: number, y: number, dx: number, dy: number): boolean | undefined {
    const a = this.footprint(x - dx, y - dy), m = this.footprint(x, y), b = this.footprint(x + dx, y + dy);
    const [ax, ay] = this.sourceCenter(x - dx, y - dy), [bx, by] = this.sourceCenter(x + dx, y + dy);
    const rect = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
    // The connection must reach the actual sampled ink on both sides. A
    // different parallel stroke elsewhere in their footprints is not evidence.
    return this.probe(rect, (sx, sy) => inside(a, sx, sy) || inside(m, sx, sy) || inside(b, sx, sy),
      (sx, sy) => (sx === ax && sy === ay ? 1 : 0) | (inside(m, sx, sy) ? 2 : 0) | (sx === bx && sy === by ? 4 : 0), bits => bits === 7);
  }

  private pruneMissedFragments(input: Uint8Array, pass: OutlinePass): void {
    const visited = new Uint8Array(input.length);
    for (let start = 0; start < input.length; start++) {
      if (!pass.changed[start] || visited[start]) continue;
      const component = [start]; visited[start] = 1;
      let thick = false;
      for (let head = 0; head < component.length; head++) {
        const p = component[head], x = p % this.w, y = Math.floor(p / this.w);
        if (x + 1 < this.w && y + 1 < this.h && pass.changed[p + 1] && pass.changed[p + this.w] && pass.changed[p + this.w + 1]) thick = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, q = p + dy * this.w + dx;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= this.w || ny >= this.h || !pass.changed[q] || visited[q]) continue;
          const a = this.footprint(x, y), b = this.footprint(nx, ny), rect = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          const connected = this.probe(rect, (sx, sy) => inside(a, sx, sy) || inside(b, sx, sy), (sx, sy) => (inside(a, sx, sy) ? 1 : 0) | (inside(b, sx, sy) ? 2 : 0), bits => bits === 3);
          if (connected === undefined) pass.skipped++;
          if (connected) { visited[q] = 1; component.push(q); }
        }
      }
      // Single cells and pairs are ambiguous specks. Fully missed broad areas
      // need reconstruction rather than a one-color outline heuristic.
      if (component.length < 3 || thick) for (const p of component) { pass.changed[p] = 0; pass.grid[p] = input[p]; pass.count--; }
    }
  }

  /** Do not sever a competing-color path which is actually connected in the source. */
  private keepsSourceConnections(input: Uint8Array, proposed: Uint8Array, p: number): boolean | undefined {
    const px = p % this.w, py = Math.floor(p / this.w), color = input[p];
    const x0 = Math.max(0, px - 1), y0 = Math.max(0, py - 1), x1 = Math.min(this.w - 1, px + 1), y1 = Math.min(this.h - 1, py + 1);
    const localWidth = x1 - x0 + 1, localHeight = y1 - y0 + 1, outputLabels = new Int8Array(9).fill(-1), outputQueue = new Uint8Array(9);
    let components = 0;
    for (let start = 0; start < localWidth * localHeight; start++) {
      const x = x0 + start % localWidth, y = y0 + Math.floor(start / localWidth), q = y * this.w + x;
      if (outputLabels[start] !== -1 || input[q] !== color || proposed[q]) continue;
      let head = 0, tail = 1;
      outputQueue[0] = start; outputLabels[start] = components;
      while (head < tail) {
        const k = outputQueue[head++], kx = k % localWidth, ky = Math.floor(k / localWidth);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = kx + dx, ny = ky + dy, n = ny * localWidth + nx;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= localWidth || ny >= localHeight || outputLabels[n] !== -1) continue;
          const nq = (y0 + ny) * this.w + x0 + nx;
          if (input[nq] === color && !proposed[nq]) { outputLabels[n] = components; outputQueue[tail++] = n; }
        }
      }
      components++;
    }
    if (!components) return false;
    if (components === 1) return true;
    const a = this.footprint(x0, y0), b = this.footprint(x1, y1), rect = { x0: a.x0, y0: a.y0, x1: b.x1, y1: b.y1 };
    const rw = rect.x1 - rect.x0 + 1, rh = rect.y1 - rect.y0 + 1, size = rw * rh;
    if (size > MAX_PATCH) return undefined;
    this.labels.fill(-1, 0, size);
    let label = 0;
    for (let start = 0; start < size; start++) {
      const sx = rect.x0 + start % rw, sy = rect.y0 + Math.floor(start / rw);
      if (this.labels[start] !== -1 || this.source[sy * this.sw + sx] !== color) continue;
      let head = 0, tail = 1;
      this.patchQueue[0] = start; this.labels[start] = label;
      while (head < tail) {
        const k = this.patchQueue[head++], kx = k % rw, ky = Math.floor(k / rw);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = kx + dx, ny = ky + dy, n = ny * rw + nx;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= rw || ny >= rh || this.labels[n] !== -1) continue;
          if (this.source[(rect.y0 + ny) * this.sw + rect.x0 + nx] === color) { this.labels[n] = label; this.patchQueue[tail++] = n; }
        }
      }
      label++;
    }
    const sourceToOutput = new Map<number, number>();
    for (let k = 0; k < localWidth * localHeight; k++) {
      if (outputLabels[k] < 0) continue;
      const [sx, sy] = this.sourceCenter(x0 + k % localWidth, y0 + Math.floor(k / localWidth));
      const sourceLabel = this.labels[(sy - rect.y0) * rw + sx - rect.x0];
      // Vector fills are not a license to infer new raster connections.
      if (sourceLabel < 0) return false;
      const previous = sourceToOutput.get(sourceLabel);
      if (previous !== undefined && previous !== outputLabels[k]) return false;
      sourceToOutput.set(sourceLabel, outputLabels[k]);
    }
    return true;
  }

  plan(input: Uint8Array, eligible: Uint8Array, immutable: Uint8Array, rules: RuleConfig): ConservativeOutlinePasses {
    if (!this.shrinking) return {};
    const preserveScope = new Uint8Array(input.length), repairScope = new Uint8Array(input.length), protectedColors = new Set(rules.protectedColorIndices ?? []);
    for (let p = 0; p < input.length; p++) {
      if (!eligible[p] || immutable[p] || input[p] === this.outline || protectedColors.has(input[p])) continue;
      // Keep sampled dots, line ends and narrow competing-color details. Source
      // support for the chosen ink alone cannot justify erasing those features.
      if (this.neighborCount(input, p, input[p]) < 4) continue;
      repairScope[p] = 1;
      // Preservation is only for wholly missed ink. Expanding the edge of an
      // already sampled stroke was the dominant regression in the first mode.
      if (!this.neighborCount(input, p, this.outline)) preserveScope[p] = 1;
    }
    const preserved = rules.rasterResize === 'preserve-outline' ? super.preserve(input, preserveScope, immutable) : undefined;
    const repaired = rules.repairOutlineGaps ? super.repair(input, repairScope, immutable, rules) : undefined;
    if (preserved) this.pruneMissedFragments(input, preserved);
    if (repaired) for (let p = 0; p < input.length; p++) {
      if (!repaired.changed[p]) continue;
      const x = p % this.w, y = Math.floor(p / this.w);
      let supported = true, pairs = 0;
      for (const [dx, dy] of DIRECTIONS) {
        const ax = x - dx, ay = y - dy, bx = x + dx, by = y + dy;
        if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= this.w || ay >= this.h || bx >= this.w || by >= this.h || input[ay * this.w + ax] !== this.outline || input[by * this.w + bx] !== this.outline) continue;
        pairs++;
        const connected = this.anchoredConnection(x, y, dx, dy);
        if (connected === undefined) repaired.skipped++;
        if (!connected) { supported = false; break; }
      }
      if (!pairs || !supported) { repaired.changed[p] = 0; repaired.grid[p] = input[p]; repaired.count--; }
    }
    const proposed = new Uint8Array(input.length), rejected = new Uint8Array(input.length);
    if (!preserved?.count && !repaired?.count) return { preserved, repaired };
    for (let p = 0; p < input.length; p++) proposed[p] = preserved?.changed[p] || repaired?.changed[p] ? 1 : 0;
    const rejectNeighbors = (p: number, color: number): void => {
      const x = p % this.w, y = Math.floor(p / this.w);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || y + dy < 0 || x + dx >= this.w || y + dy >= this.h) continue;
        const q = p + dy * this.w + dx;
        if (proposed[q] && input[q] === color) rejected[q] = 1;
      }
    };
    for (let p = 0; p < input.length; p++) {
      if (proposed[p]) {
        const kept = this.keepsSourceConnections(input, proposed, p);
        if (kept === undefined) { if (preserved?.changed[p]) preserved.skipped++; else if (repaired?.changed[p]) repaired.skipped++; }
        if (!kept) rejectNeighbors(p, input[p]);
      } else if (input[p] !== this.outline) {
        const before = this.neighborCount(input, p, input[p]), x = p % this.w, y = Math.floor(p / this.w);
        // The cropped image boundary has fewer neighbors by construction. Keep
        // a surviving neighbor there; interior details must also retain their
        // second neighbor so a batch does not create an isolated line end.
        const minimum = x === 0 || y === 0 || x === this.w - 1 || y === this.h - 1 ? 1 : 2;
        if (before && this.neighborCount(input, p, input[p], proposed) < Math.min(before, minimum)) rejectNeighbors(p, input[p]);
      }
    }
    for (const pass of [preserved, repaired]) if (pass) for (let p = 0; p < input.length; p++) if (pass.changed[p] && rejected[p]) {
      pass.changed[p] = 0; pass.grid[p] = input[p]; pass.count--;
    }
    if (preserved) this.pruneMissedFragments(input, preserved);
    return { preserved, repaired };
  }
}
