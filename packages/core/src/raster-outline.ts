import type { RuleConfig } from './types';

// Each proof examines a small local source patch. Extremely large reductions
// keep the ordinary sample and report the skipped proof instead of allocating
// a full-image component graph or inventing a connection.
const MAX_PROBE_PIXELS = 4096;
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]] as const;
export interface OutlineRect { x0: number; y0: number; x1: number; y1: number }
type Rect = OutlineRect;
export interface OutlinePass { grid: Uint8Array; changed: Uint8Array; count: number; skipped: number }

/** Source-backed, indexed-color assistance. It never blends or creates a color. */
export class RasterOutlineEvidence {
  private queue = new Int32Array(MAX_PROBE_PIXELS);
  private visited = new Uint8Array(MAX_PROBE_PIXELS);
  private readonly columns: Int32Array;
  private readonly rows: Int32Array;
  readonly shrinking: boolean;

  constructor(protected source: Uint8Array, protected sw: number, protected sh: number, protected w: number, protected h: number, protected outline: number) {
    this.shrinking = w <= sw && h <= sh && (w < sw || h < sh);
    this.columns = Int32Array.from({ length: w + 1 }, (_, x) => Math.max(0, Math.min(sw, Math.ceil(x * sw / w - 0.5))));
    this.rows = Int32Array.from({ length: h + 1 }, (_, y) => Math.max(0, Math.min(sh, Math.ceil(y * sh / h - 0.5))));
  }

  protected footprint(x: number, y: number): Rect {
    // Assign every source pixel center to exactly one footprint. A narrow line
    // on a footprint boundary cannot be duplicated into both output columns.
    return { x0: this.columns[x], y0: this.rows[y], x1: this.columns[x + 1] - 1, y1: this.rows[y + 1] - 1 };
  }

  protected probe(rect: Rect, allowed: (x: number, y: number) => boolean, seed: (x: number, y: number) => number, success: (bits: number) => boolean): boolean | undefined {
    const rw = rect.x1 - rect.x0 + 1, rh = rect.y1 - rect.y0 + 1, size = rw * rh;
    if (rw < 1 || rh < 1) return false;
    if (size > MAX_PROBE_PIXELS) return undefined;
    this.visited.fill(0, 0, size);
    for (let start = 0; start < size; start++) {
      if (this.visited[start]) continue;
      const sx = rect.x0 + start % rw, sy = rect.y0 + Math.floor(start / rw);
      if (!allowed(sx, sy) || this.source[sy * this.sw + sx] !== this.outline) continue;
      let head = 0, tail = 1, bits = 0;
      this.queue[0] = start; this.visited[start] = 1;
      while (head < tail) {
        const p = this.queue[head++], lx = p % rw, ly = Math.floor(p / rw), x = rect.x0 + lx, y = rect.y0 + ly;
        bits |= seed(x, y);
        if (success(bits)) return true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || lx + dx < 0 || lx + dx >= rw || ly + dy < 0 || ly + dy >= rh) continue;
          const q = p + dy * rw + dx;
          if (!this.visited[q] && allowed(x + dx, y + dy) && this.source[(y + dy) * this.sw + x + dx] === this.outline) { this.visited[q] = 1; this.queue[tail++] = q; }
        }
      }
    }
    return false;
  }

  private connection(x: number, y: number, dx: number, dy: number): boolean | undefined {
    const a = this.footprint(x - dx, y - dy), middle = this.footprint(x, y), b = this.footprint(x + dx, y + dy);
    const rect = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
    const inside = (r: Rect, sx: number, sy: number): boolean => sx >= r.x0 && sx <= r.x1 && sy >= r.y0 && sy <= r.y1;
    // A real continuous 8-connected source component must visit all three
    // footprints. Merely having some outline color in the gap is insufficient.
    return this.probe(rect, (sx, sy) => inside(a, sx, sy) || inside(middle, sx, sy) || inside(b, sx, sy),
      (sx, sy) => inside(a, sx, sy) ? 1 : inside(b, sx, sy) ? 4 : inside(middle, sx, sy) ? 2 : 0,
      bits => bits === 7);
  }

  private oppositeOutline(input: Uint8Array, x: number, y: number, dx: number, dy: number): boolean {
    const ax = x - dx, ay = y - dy, bx = x + dx, by = y + dy;
    return ax >= 0 && ay >= 0 && bx >= 0 && by >= 0 && ax < this.w && bx < this.w && ay < this.h && by < this.h && input[ay * this.w + ax] === this.outline && input[by * this.w + bx] === this.outline;
  }

  preserve(input: Uint8Array, eligible: Uint8Array, immutable: Uint8Array): OutlinePass {
    const grid = input.slice(), changed = new Uint8Array(input.length);
    let count = 0, skipped = 0;
    if (!this.shrinking) return { grid, changed, count, skipped };
    for (let p = 0; p < input.length; p++) {
      if (!eligible[p] || immutable[p] || input[p] === this.outline) continue;
      const x = p % this.w, y = Math.floor(p / this.w), rect = this.footprint(x, y);
      const spans = this.probe(rect, () => true,
        (x, y) => (x === rect.x0 ? 1 : 0) | (x === rect.x1 ? 2 : 0) | (y === rect.y0 ? 4 : 0) | (y === rect.y1 ? 8 : 0),
        bits => (rect.x1 > rect.x0 && (bits & 3) === 3) || (rect.y1 > rect.y0 && (bits & 12) === 12));
      if (spans === undefined) skipped++;
      else if (spans) {
        // Do not sacrifice a sampled gap between separate parallel outlines.
        // Every pair we would join must already connect in the source patch.
        let supported = true;
        for (const [dx, dy] of DIRECTIONS) if (this.oppositeOutline(input, x, y, dx, dy)) {
          const connected = this.connection(x, y, dx, dy);
          if (connected === undefined) skipped++;
          if (!connected) { supported = false; break; }
        }
        if (supported) { grid[p] = this.outline; changed[p] = 1; count++; }
      }
    }
    return { grid, changed, count, skipped };
  }

  repair(input: Uint8Array, eligible: Uint8Array, immutable: Uint8Array, rules: RuleConfig): OutlinePass {
    const grid = input.slice(), changed = new Uint8Array(input.length), protectedColors = new Set(rules.protectedColorIndices ?? []);
    let count = 0, skipped = 0;
    if (!this.shrinking) return { grid, changed, count, skipped };
    for (let p = 0; p < input.length; p++) {
      if (!eligible[p] || immutable[p] || input[p] === this.outline || protectedColors.has(input[p])) continue;
      const x = p % this.w, y = Math.floor(p / this.w);
      for (const [dx, dy] of DIRECTIONS) {
        if (!this.oppositeOutline(input, x, y, dx, dy)) continue;
        const supported = this.connection(x, y, dx, dy);
        if (supported === undefined) skipped++;
        else if (supported) {
          let safe = true;
          for (const [otherDx, otherDy] of DIRECTIONS) if ((otherDx !== dx || otherDy !== dy) && this.oppositeOutline(input, x, y, otherDx, otherDy)) {
            const connected = this.connection(x, y, otherDx, otherDy);
            if (connected === undefined) skipped++;
            if (!connected) { safe = false; break; }
          }
          if (safe) { grid[p] = this.outline; changed[p] = 1; count++; break; }
        }
      }
    }
    return { grid, changed, count, skipped };
  }
}
