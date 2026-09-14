import type { BezierSegment, DesignObject, Geometry, RasterInput, TraceParams, TraceResult, Vec2 } from './types.js';

/** All stages copy their inputs. Source/master pixels are never modified. */
const snap = (v: number): number => Math.round(v * 64) / 64;
const point = (p: Vec2): Vec2 => ({ x: snap(p.x), y: snap(p.y) });
const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (p: Vec2, s: number): Vec2 => ({ x: p.x * s, y: p.y * s });
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const normalize = (v: Vec2): Vec2 => scale(v, 1 / (Math.hypot(v.x, v.y) || 1));
const readingOrder = (a: Vec2, b: Vec2): number => a.y - b.y || a.x - b.x;

function assertRaster(input: RasterInput): void {
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1)
    throw new Error('Raster dimensions must be positive integers.');
  if (![1, 3, 4].includes(input.channels) || input.data.length !== input.width * input.height * input.channels)
    throw new Error('Raster data must match width × height × channels (1, 3 or 4).');
}

/** Alpha is composited onto white before luminance/inversion; transparent black is background. */
export function rasterLuminance(input: RasterInput, invert = false): Uint8Array {
  assertRaster(input);
  const result = new Uint8Array(input.width * input.height);
  for (let i = 0; i < result.length; i++) {
    const j = i * input.channels;
    let luminance = input.channels === 1 ? input.data[j]
      : (2126 * input.data[j] + 7152 * input.data[j + 1] + 722 * input.data[j + 2]) / 10000;
    if (input.channels === 4) luminance = 255 + (luminance - 255) * input.data[j + 3] / 255;
    result[i] = Math.round(invert ? 255 - luminance : luminance);
  }
  return result;
}

export function otsuThreshold(gray: Uint8Array): number {
  if (!gray.length) return 127;
  const histogram = new Uint32Array(256);
  let total = 0;
  let minimum = 255;
  let maximum = 0;
  for (const g of gray) { histogram[g]++; total += g; minimum = Math.min(minimum, g); maximum = Math.max(maximum, g); }
  // A uniform bright image must not turn into a solid foreground rectangle.
  if (minimum === maximum) return minimum < 128 ? minimum : minimum - 1;
  let backgroundCount = 0;
  let backgroundSum = 0;
  let best = -1;
  let threshold = minimum;
  for (let t = minimum; t < maximum; t++) {
    backgroundCount += histogram[t];
    backgroundSum += t * histogram[t];
    const foregroundCount = gray.length - backgroundCount;
    if (!backgroundCount || !foregroundCount) continue;
    const delta = backgroundSum / backgroundCount - (total - backgroundSum) / foregroundCount;
    const variance = backgroundCount * foregroundCount * delta * delta;
    if (variance > best) { best = variance; threshold = t; }
  }
  return threshold;
}

export function binarize(input: RasterInput, threshold: number | 'otsu' = 'otsu', invert = false): { binary: Uint8Array; threshold: number } {
  if (threshold !== 'otsu' && (!Number.isFinite(threshold) || threshold < 0 || threshold > 255))
    throw new Error('Threshold must be otsu or a number from 0 to 255.');
  const gray = rasterLuminance(input, invert);
  const selected = threshold === 'otsu' ? otsuThreshold(gray) : threshold;
  return { binary: gray.map(g => g <= selected ? 1 : 0), threshold: selected };
}

function rasterNeighbors(index: number, width: number, height: number, visit: (index: number) => void): void {
  const x = index % width;
  const y = Math.floor(index / width);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if ((!dx && !dy) || x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height) continue;
    visit(index + dy * width + dx);
  }
}

/** Eight-connected foreground components and fully enclosed white pinholes. */
export function despeckle(binary: Uint8Array, width: number, height: number, minArea: number): Uint8Array {
  const result = binary.slice();
  if (minArea <= 1) return result;
  const seen = new Uint8Array(result.length);
  const queue = new Int32Array(result.length);
  for (const value of [1, 0]) {
    seen.fill(0);
    for (let seed = 0; seed < result.length; seed++) {
      if (seen[seed] || result[seed] !== value) continue;
      let head = 0;
      let tail = 1;
      let touchesBorder = false;
      queue[0] = seed;
      seen[seed] = 1;
      while (head < tail) {
        const p = queue[head++];
        const x = p % width;
        const y = Math.floor(p / width);
        if (!x || !y || x === width - 1 || y === height - 1) touchesBorder = true;
        rasterNeighbors(p, width, height, q => {
          if (!seen[q] && result[q] === value) { seen[q] = 1; queue[tail++] = q; }
        });
      }
      if (tail < minArea && (value === 1 || !touchesBorder))
        for (let i = 0; i < tail; i++) result[queue[i]] = value === 1 ? 0 : 1;
    }
  }
  return result;
}

/** Zhang–Suen two-subiteration thinning, with a white boundary outside the image. */
export function skeletonize(binary: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width + 2;
  const work = new Uint8Array(stride * (height + 2));
  const active: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (binary[y * width + x]) { const i = (y + 1) * stride + x + 1; work[i] = 1; active.push(i); }
  }
  const offsets = [-stride, -stride + 1, 1, stride + 1, stride, stride - 1, -1, -stride - 1];
  let changed = true;
  while (changed) {
    changed = false;
    for (let phase = 0; phase < 2; phase++) {
      const remove: number[] = [];
      for (const p of active) {
        if (!work[p]) continue;
        let count = 0;
        let transitions = 0;
        for (let k = 0; k < 8; k++) {
          count += work[p + offsets[k]];
          if (!work[p + offsets[k]] && work[p + offsets[(k + 1) % 8]]) transitions++;
        }
        if (count < 2 || count > 6 || transitions !== 1) continue;
        const n = work[p - stride], e = work[p + 1], s = work[p + stride], w = work[p - 1];
        if (phase === 0 ? n * e * s === 0 && e * s * w === 0 : n * e * w === 0 && n * s * w === 0) remove.push(p);
      }
      for (const p of remove) work[p] = 0;
      if (remove.length) changed = true;
    }
  }
  const result = new Uint8Array(binary.length);
  for (let y = 0; y < height; y++) result.set(work.subarray((y + 1) * stride + 1, (y + 1) * stride + width + 1), y * width);
  return result;
}

/** Chamfer distance transform with orthogonal cost 1 and diagonal cost sqrt(2). */
export function estimateLineWidth(binary: Uint8Array, skeleton: Uint8Array, width: number, height: number): number {
  const d = new Float32Array(binary.length);
  const diagonal = Math.SQRT2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!binary[i]) continue;
    d[i] = Math.min(x ? d[i - 1] + 1 : 1, y ? d[i - width] + 1 : 1,
      x && y ? d[i - width - 1] + diagonal : diagonal,
      x < width - 1 && y ? d[i - width + 1] + diagonal : diagonal);
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    if (!binary[i]) continue;
    d[i] = Math.min(d[i], x < width - 1 ? d[i + 1] + 1 : 1, y < height - 1 ? d[i + width] + 1 : 1,
      x < width - 1 && y < height - 1 ? d[i + width + 1] + diagonal : diagonal,
      x && y < height - 1 ? d[i + width - 1] + diagonal : diagonal);
  }
  const samples: number[] = [];
  for (let i = 0; i < d.length; i++) if (skeleton[i]) samples.push(d[i]);
  if (!samples.length) return 0;
  samples.sort((a, b) => a - b);
  return snap(2 * samples[Math.floor(samples.length / 2)]);
}

export interface TracePath { start: number; end: number; points: Vec2[] }
export interface SkeletonGraph { vertices: Vec2[]; paths: TracePath[] }

/** Diagonal links are omitted when an orthogonal route already exists: no triangular corner artifacts. */
function skeletonNeighbors(p: number, skeleton: Uint8Array, width: number, height: number): number[] {
  const neighbors: number[] = [];
  const x = p % width;
  rasterNeighbors(p, width, height, q => {
    if (!skeleton[q]) return;
    const dx = q % width - x;
    const dy = Math.floor(q / width) - Math.floor(p / width);
    if (dx && dy && (skeleton[p + dx] || skeleton[p + dy * width])) return;
    neighbors.push(q);
  });
  return neighbors;
}

export function extractSkeletonGraph(skeleton: Uint8Array, width: number, height: number): SkeletonGraph {
  const pixels: number[] = [];
  const adjacency = new Map<number, number[]>();
  for (let i = 0; i < skeleton.length; i++) if (skeleton[i]) {
    pixels.push(i); adjacency.set(i, skeletonNeighbors(i, skeleton, width, height));
  }
  const graph: SkeletonGraph = { vertices: [], paths: [] };
  const vertexOf = new Map<number, number>();
  const members: number[][] = [];
  const position = (p: number): Vec2 => ({ x: p % width + 0.5, y: Math.floor(p / width) + 0.5 });
  for (const p of pixels) {
    const degree = adjacency.get(p)!.length;
    if (degree === 2 || degree === 0 || vertexOf.has(p)) continue;
    const cluster = [p];
    const id = graph.vertices.length;
    vertexOf.set(p, id);
    if (degree >= 3) for (let j = 0; j < cluster.length; j++) for (const q of adjacency.get(cluster[j])!) {
      if (!vertexOf.has(q) && adjacency.get(q)!.length >= 3) { vertexOf.set(q, id); cluster.push(q); }
    }
    const center = cluster.reduce((sum, q) => add(sum, position(q)), { x: 0, y: 0 });
    graph.vertices.push(point(scale(center, 1 / cluster.length)));
    members.push(cluster);
  }
  const visited = new Set<string>();
  const key = (a: number, b: number): string => a < b ? `${a}:${b}` : `${b}:${a}`;
  const walk = (seed: number, next: number, start: number): void => {
    const points = [graph.vertices[start]];
    let previous = seed;
    let current = next;
    visited.add(key(previous, current));
    let end: number | undefined;
    for (let safety = 0; safety <= pixels.length; safety++) {
      if (vertexOf.has(current)) { end = vertexOf.get(current)!; points.push(graph.vertices[end]); break; }
      points.push(position(current));
      const candidates = adjacency.get(current)!.filter(q => q !== previous);
      if (!candidates.length) break;
      const q = candidates[0];
      visited.add(key(current, q));
      previous = current;
      current = q;
    }
    if (end !== undefined && points.length >= 2 && !(start === end && points.length <= 2))
      graph.paths.push({ start, end, points: points.filter((p, i) => !i || distance(p, points[i - 1]) > 0) });
  };
  for (let v = 0; v < members.length; v++) for (const p of members[v]) for (const q of adjacency.get(p)!) {
    if (vertexOf.get(q) === v) { visited.add(key(p, q)); continue; }
    if (!visited.has(key(p, q))) walk(p, q, v);
  }
  // A component with degree 2 everywhere has no vertex yet. Seed its top-left pixel.
  for (const p of pixels) for (const q of adjacency.get(p)!) if (!visited.has(key(p, q))) {
    if (!vertexOf.has(p)) { vertexOf.set(p, graph.vertices.length); graph.vertices.push(position(p)); }
    walk(p, q, vertexOf.get(p)!);
  }
  return graph;
}

const pathLength = (p: TracePath): number => p.points.slice(1).reduce((sum, v, i) => sum + distance(v, p.points[i]), 0);
function degrees(graph: SkeletonGraph): number[] {
  const result = graph.vertices.map(() => 0);
  for (const path of graph.paths) { result[path.start]++; result[path.end]++; }
  return result;
}

function incidentPathIndices(graph: SkeletonGraph): number[][] {
  const result: number[][] = graph.vertices.map(() => []);
  graph.paths.forEach((path, index) => { result[path.start].push(index); result[path.end].push(index); });
  return result;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Exact ray/cell traversal: distance from a point inside source ink to its first foreground exit. */
function inkExitDistance(origin: Vec2, direction: Vec2, binary: Uint8Array, width: number, height: number, limit = Infinity): number | undefined {
  let x = Math.floor(origin.x), y = Math.floor(origin.y);
  if (x < 0 || y < 0 || x >= width || y >= height || !binary[y * width + x]) return undefined;
  const stepX = Math.sign(direction.x), stepY = Math.sign(direction.y);
  let nextX = stepX ? ((stepX > 0 ? x + 1 : x) - origin.x) / direction.x : Infinity;
  let nextY = stepY ? ((stepY > 0 ? y + 1 : y) - origin.y) / direction.y : Infinity;
  const deltaX = stepX ? Math.abs(1 / direction.x) : Infinity;
  const deltaY = stepY ? Math.abs(1 / direction.y) : Infinity;
  if (!stepX && !stepY) return undefined;
  for (;;) {
    const distance = Math.min(nextX, nextY);
    if (distance > limit) return undefined;
    // Cross both grid boundaries at exact corners; zero-area neighboring cells do not contribute ink.
    if (Math.abs(nextX - distance) <= 1e-10) { x += stepX; nextX += deltaX; }
    if (Math.abs(nextY - distance) <= 1e-10) { y += stepY; nextY += deltaY; }
    if (x < 0 || y < 0 || x >= width || y >= height || !binary[y * width + x]) return Math.max(0, distance);
  }
}

/**
 * Estimate each edge's original source thickness from normal cross-sections of its raw centerline.
 * Arc-spaced samples avoid pixel-center phase bias; endpoint trimming and a median reduce junction/tip inflation.
 * The returned width is constant per path, so genuine tapered strokes remain an approximation.
 */
export function estimatePathStrokeWidths(graph: SkeletonGraph, binary: Uint8Array, width: number, height: number, globalWidthEstimate: number): { widths: number[]; inherited: number } {
  const measured: (number | undefined)[] = [];
  const supportDirections = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, { x: Math.SQRT1_2, y: -Math.SQRT1_2 }];
  for (const path of graph.paths) {
    const points = path.points, cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
    const length = cumulative[cumulative.length - 1];
    if (!length) { measured.push(undefined); continue; }
    const closed = path.start === path.end;
    const at = (arc: number): Vec2 => {
      const s = closed ? (arc % length + length) % length : Math.max(0, Math.min(length, arc));
      let low = 0, high = cumulative.length - 1;
      while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (cumulative[middle] < s) low = middle; else high = middle; }
      const span = cumulative[high] - cumulative[low];
      return span ? add(points[low], scale(sub(points[high], points[low]), (s - cumulative[low]) / span)) : points[low];
    };
    const trim = closed ? 0 : Math.min(Math.max(2, globalWidthEstimate), length * 0.2);
    const samples = Math.max(3, Math.min(31, Math.ceil(length - 2 * trim)));
    const tangentWindow = Math.max(0.5, Math.min(3, length * 0.1));
    const crossSections: number[] = [];
    for (let i = 0; i < samples; i++) {
      const s = trim + (i + 0.5) / samples * (length - 2 * trim), origin = at(s);
      const tangent = normalize(sub(at(s + tangentWindow), at(s - tangentWindow)));
      const normal = { x: -tangent.y, y: tangent.x };
      const positive = inkExitDistance(origin, normal, binary, width, height);
      const negative = inkExitDistance(origin, scale(normal, -1), binary, width, height);
      if (positive !== undefined && negative !== undefined && positive + negative > 1e-6) {
        const normalWidth = positive + negative;
        let supportWidth = normalWidth;
        // A tiny junction path can have an unreliable tangent whose normal follows a neighboring
        // stroke for thousands of pixels. Limit it using the narrowest local opposing-ray support.
        // Probes stop at the best known width, so long parallel strokes do not add unbounded work.
        for (const direction of supportDirections) {
          const a = inkExitDistance(origin, direction, binary, width, height, supportWidth);
          if (a === undefined) continue;
          const b = inkExitDistance(origin, scale(direction, -1), binary, width, height, supportWidth - a);
          if (b !== undefined && a + b > 1e-6) supportWidth = Math.min(supportWidth, a + b);
        }
        crossSections.push(Math.min(normalWidth, supportWidth * 1.25));
      }
    }
    measured.push(crossSections.length ? Math.max(1 / 64, snap(median(crossSections))) : undefined);
  }
  const incident = incidentPathIndices(graph);
  let inherited = 0;
  const widths = measured.map((value, index) => {
    if (value !== undefined) return value;
    inherited++;
    const path = graph.paths[index];
    const neighbors = [...new Set([...incident[path.start], ...incident[path.end]])]
      .filter(other => other !== index && measured[other] !== undefined).map(other => measured[other]!);
    // Legacy width uses 2 × center-to-background distance, one pixel too large for an odd-width axis-aligned stroke.
    return neighbors.length ? Math.max(1 / 64, snap(median(neighbors))) : Math.max(1, snap(globalWidthEstimate - 1));
  });
  return { widths, inherited };
}

/** Only short terminal branches of junctions are removed; isolated strokes and closed loops survive. */
export function pruneSpurs(input: SkeletonGraph, maximumLength: number): { graph: SkeletonGraph; pruned: number } {
  const graph = { vertices: input.vertices.slice(), paths: input.paths.slice() };
  let pruned = 0;
  if (maximumLength <= 0) return { graph, pruned };
  for (;;) {
    const degree = degrees(graph);
    const keep = graph.paths.filter(path => {
      const terminal = degree[path.start] === 1 && degree[path.end] >= 3 || degree[path.end] === 1 && degree[path.start] >= 3;
      if (terminal && pathLength(path) < maximumLength) { pruned++; return false; }
      return true;
    });
    if (keep.length === graph.paths.length) break;
    graph.paths = keep;
  }
  return { graph, pruned };
}

/** Diagnostic only: a short branch opposite two acute-angle branches often comes from thinning a sharp outline tip.
 * Such geometry may also be intentional, so it is never deleted or auto-closed by this classification.
 */
export function findPossibleTipSpurs(graph: SkeletonGraph, lineWidth: number): { endpoint: Vec2; junction: Vec2; length: number }[] {
  const degree = degrees(graph);
  const incidentPaths = incidentPathIndices(graph);
  const result: { endpoint: Vec2; junction: Vec2; length: number }[] = [];
  for (const branch of graph.paths) {
    let end: number | undefined;
    let junction: number | undefined;
    if (degree[branch.start] === 1 && degree[branch.end] === 3) { end = branch.start; junction = branch.end; }
    else if (degree[branch.end] === 1 && degree[branch.start] === 3) { end = branch.end; junction = branch.start; }
    if (end === undefined || junction === undefined || pathLength(branch) > Math.max(2, 4 * lineWidth)) continue;
    const origin = graph.vertices[junction];
    const tipDirection = normalize(sub(graph.vertices[end], origin));
    const directions: Vec2[] = [];
    for (const pathIndex of new Set(incidentPaths[junction])) {
      const path = graph.paths[pathIndex];
      if (path === branch) continue;
      const incident = [path.start === junction ? path.points : null, path.end === junction ? path.points.slice().reverse() : null];
      for (const points of incident) if (points) {
        const reference = points.find(p => distance(p, origin) >= Math.max(2, lineWidth * 2)) ?? points[points.length - 1];
        directions.push(normalize(sub(reference, origin)));
      }
    }
    if (directions.length === 2 && dot(directions[0], directions[1]) >= 0 && directions.every(d => dot(d, tipDirection) < -0.4))
      result.push({ endpoint: graph.vertices[end], junction: origin, length: snap(pathLength(branch)) });
  }
  return result.sort((a, b) => readingOrder(a.endpoint, b.endpoint));
}

function endpointTangent(graph: SkeletonGraph, vertex: number, incidentPath?: TracePath): Vec2 {
  const path = incidentPath ?? graph.paths.find(p => p.start === vertex || p.end === vertex)!;
  const points = path.start === vertex ? path.points : path.points.slice().reverse();
  let i = 1;
  while (i < points.length - 1 && distance(points[0], points[i]) < 4) i++;
  return normalize(sub(points[0], points[i]));
}

/** Tests every raster cell crossed by a segment, including brief diagonal crossings. */
function foregroundAlongSegment(from: Vec2, to: Vec2, binary: Uint8Array, width: number, height: number): boolean {
  const boundaries = [0, 1];
  for (const axis of ['x', 'y'] as const) {
    if (from[axis] === to[axis]) continue;
    const low = Math.min(from[axis], to[axis]), high = Math.max(from[axis], to[axis]);
    for (let coordinate = Math.floor(low) + 1; coordinate < high; coordinate++) {
      const t = (coordinate - from[axis]) / (to[axis] - from[axis]);
      if (t > 0 && t < 1) boundaries.push(t);
    }
  }
  boundaries.sort((a, b) => a - b);
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] === boundaries[i - 1]) continue;
    const t = (boundaries[i - 1] + boundaries[i]) / 2;
    const x = Math.max(0, Math.min(width - 1, Math.floor(from.x + (to.x - from.x) * t)));
    const y = Math.max(0, Math.min(height - 1, Math.floor(from.y + (to.y - from.y) * t)));
    if (!binary[y * width + x]) return false;
  }
  return true;
}

/**
 * Raster coordinates describe pixel centers, while the repeat cell ends at pixel edges.
 * Thinning can also retreat an endpoint by half the stroke width. Extend only outward
 * terminals with an uninterrupted ORIGINAL foreground path to the source border.
 * Nearby interior strokes separated from the border by any white pixel are untouched.
 */
export function extendSourceBorderEnds(input: SkeletonGraph, sourceBinary: Uint8Array, width: number, height: number, lineWidth: number): { graph: SkeletonGraph; extended: { from: Vec2; to: Vec2 }[] } {
  const graph: SkeletonGraph = { vertices: input.vertices.slice(), paths: input.paths.slice() };
  const degree = degrees(input);
  const incidentPaths = incidentPathIndices(input);
  const extended: { from: Vec2; to: Vec2 }[] = [];
  for (let vertex = 0; vertex < input.vertices.length; vertex++) {
    if (degree[vertex] !== 1) continue;
    const from = input.vertices[vertex];
    const pathIndex = incidentPaths[vertex][0];
    const tangent = endpointTangent(input, vertex, input.paths[pathIndex]);
    const candidates: { distance: number; to: Vec2 }[] = [];
    for (const axis of ['x', 'y'] as const) {
      if (Math.abs(tangent[axis]) < 1e-9) continue;
      const boundary = tangent[axis] < 0 ? 0 : axis === 'x' ? width : height;
      const d = (boundary - from[axis]) / tangent[axis];
      if (d <= 0 || d > Math.max(1, lineWidth)) continue;
      const to = add(from, scale(tangent, d));
      to[axis] = boundary;
      if (to.x < -1e-9 || to.x > width + 1e-9 || to.y < -1e-9 || to.y > height + 1e-9) continue;
      candidates.push({ distance: d, to: point(to) });
    }
    candidates.sort((a, b) => a.distance - b.distance || readingOrder(a.to, b.to));
    const candidate = candidates.find(c => foregroundAlongSegment(from, c.to, sourceBinary, width, height));
    if (!candidate) continue;
    const to = candidate.to;
    graph.vertices[vertex] = to;
    const path = graph.paths[pathIndex];
    graph.paths[pathIndex] = path.start === vertex
      ? { ...path, points: [to, ...path.points] }
      : { ...path, points: [...path.points, to] };
    extended.push({ from, to });
  }
  return { graph, extended };
}

function projection(p: Vec2, a: Vec2, b: Vec2): { p: Vec2; t: number } {
  const d = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), d) / (dot(d, d) || 1)));
  return { p: add(a, scale(d, t)), t };
}

/** Stable nearest-first repair. Endpoint pairs take priority and both must face the gap. */
export function closeGaps(input: SkeletonGraph, maximumDistance: number): { graph: SkeletonGraph; closed: { from: Vec2; to: Vec2 }[] } {
  const graph: SkeletonGraph = { vertices: input.vertices.slice(), paths: input.paths.slice() };
  const closed: { from: Vec2; to: Vec2 }[] = [];
  if (maximumDistance <= 0) return { graph, closed };
  const cosine = Math.SQRT1_2 - 1e-9;
  const degree = degrees(graph), incidentPaths = incidentPathIndices(graph);
  const endpoints = graph.vertices.map((_, i) => i).filter(i => degree[i] === 1).sort((a, b) => readingOrder(graph.vertices[a], graph.vertices[b]) || a - b);
  const endpointRank = new Map(endpoints.map((v, i) => [v, i]));
  const active = new Set(endpoints);
  const cellSize = Math.max(4, maximumDistance * 2);
  const cellKey = (x: number, y: number): string => `${x}:${y}`;
  const cells = (a: Vec2, b: Vec2, margin: number, visit: (key: string) => void): void => {
    for (let y = Math.floor((Math.min(a.y, b.y) - margin) / cellSize); y <= Math.floor((Math.max(a.y, b.y) + margin) / cellSize); y++)
      for (let x = Math.floor((Math.min(a.x, b.x) - margin) / cellSize); x <= Math.floor((Math.max(a.x, b.x) + margin) / cellSize); x++) visit(cellKey(x, y));
  };
  const endpointGrid = new Map<string, number[]>();
  for (const vertex of endpoints) {
    const p = graph.vertices[vertex], key = cellKey(Math.floor(p.x / cellSize), Math.floor(p.y / cellSize));
    const bucket = endpointGrid.get(key) ?? []; bucket.push(vertex); endpointGrid.set(key, bucket);
  }
  const tangents = new Map(endpoints.map(v => [v, endpointTangent(input, v, input.paths[incidentPaths[v][0]])]));
  const pairs: { from: number; to: number; distance: number }[] = [];
  for (const from of endpoints) {
    const origin = graph.vertices[from];
    cells(origin, origin, maximumDistance, key => {
      for (const to of endpointGrid.get(key) ?? []) {
        if (endpointRank.get(to)! <= endpointRank.get(from)!) continue;
        const vector = sub(graph.vertices[to], origin), d = Math.hypot(vector.x, vector.y);
        if (!d || d > maximumDistance) continue;
        if (dot(tangents.get(from)!, scale(vector, 1 / d)) < cosine || dot(tangents.get(to)!, scale(vector, -1 / d)) < cosine) continue;
        pairs.push({ from, to, distance: d });
      }
    });
  }
  pairs.sort((a, b) => a.distance - b.distance || endpointRank.get(a.from)! - endpointRank.get(b.from)! || endpointRank.get(a.to)! - endpointRank.get(b.to)!);
  for (const { from, to } of pairs) if (active.has(from) && active.has(to)) {
    graph.paths.push({ start: from, end: to, points: [graph.vertices[from], graph.vertices[to]] });
    closed.push({ from: graph.vertices[from], to: graph.vertices[to] });
    active.delete(from); active.delete(to); degree[from]++; degree[to]++;
  }
  if (!active.size) return { graph, closed };

  interface PathRecord { id: number; path: TracePath; active: boolean }
  interface SegmentRecord { owner: PathRecord; index: number; a: Vec2; b: Vec2 }
  interface Hit { from: number; segment: SegmentRecord; p: Vec2; distance: number; target?: number; version: number }
  const records: PathRecord[] = [], segmentGrid = new Map<string, SegmentRecord[]>();
  const endpointPaths = new Map<number, PathRecord>();
  const addPath = (path: TracePath): SegmentRecord[] => {
    const owner: PathRecord = { id: records.length, path, active: true }; records.push(owner);
    if (active.has(path.start)) endpointPaths.set(path.start, owner);
    if (active.has(path.end)) endpointPaths.set(path.end, owner);
    const segments: SegmentRecord[] = [];
    for (let index = 0; index < path.points.length - 1; index++) {
      const segment = { owner, index, a: path.points[index], b: path.points[index + 1] }; segments.push(segment);
      cells(segment.a, segment.b, 0, key => { const bucket = segmentGrid.get(key) ?? []; bucket.push(segment); segmentGrid.set(key, bucket); });
    }
    return segments;
  };
  graph.paths.forEach(addPath);
  const compare = (a: Hit, b: Hit): number => a.distance - b.distance || endpointRank.get(a.from)! - endpointRank.get(b.from)! || a.segment.owner.id - b.segment.owner.id || a.segment.index - b.segment.index;
  const heap: Hit[] = [];
  const push = (hit: Hit): void => {
    heap.push(hit); let i = heap.length - 1;
    while (i > 0) { const parent = Math.floor((i - 1) / 2); if (compare(heap[parent], heap[i]) <= 0) break; [heap[parent], heap[i]] = [heap[i], heap[parent]]; i = parent; }
  };
  const pop = (): Hit => {
    const result = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) { let child = i * 2 + 1; if (child >= heap.length) break; if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) < 0) child++;
        if (compare(heap[i], heap[child]) <= 0) break; [heap[i], heap[child]] = [heap[child], heap[i]]; i = child; }
    }
    return result;
  };
  const versions = new Int32Array(input.vertices.length);
  const enqueue = (from: number): void => {
    if (!active.has(from)) return;
    const version = ++versions[from], origin = graph.vertices[from];
    const tangent = endpointTangent(graph, from, endpointPaths.get(from)!.path);
    const candidates = new Set<SegmentRecord>();
    cells(origin, origin, maximumDistance, key => { for (const segment of segmentGrid.get(key) ?? []) if (segment.owner.active) candidates.add(segment); });
    let best: Hit | undefined;
    for (const segment of candidates) {
      const path = segment.owner.path;
      if (path.start === from || path.end === from) continue;
      const p = point(projection(origin, segment.a, segment.b).p), d = distance(origin, p);
      if (!d || d > maximumDistance || dot(tangent, scale(sub(p, origin), 1 / d)) < cosine) continue;
      const target = distance(p, graph.vertices[path.start]) < 1 / 64 ? path.start : distance(p, graph.vertices[path.end]) < 1 / 64 ? path.end : undefined;
      // A pair rejected by its mutual tangent check must not bypass that check here.
      if (target !== undefined && degree[target] === 1) continue;
      const hit: Hit = { from, segment, p, distance: d, target, version };
      if (!best || compare(hit, best) < 0) best = hit;
    }
    if (best) push(best);
  };
  for (const from of active) enqueue(from);
  while (heap.length) {
    const hit = pop();
    if (!active.has(hit.from) || hit.version !== versions[hit.from]) continue;
    if (!hit.segment.owner.active) { enqueue(hit.from); continue; }
    let to = hit.target;
    const introduced: SegmentRecord[] = [];
    if (to === undefined) {
      to = graph.vertices.length; graph.vertices.push(hit.p); degree.push(2);
      const old = hit.segment.owner.path;
      hit.segment.owner.active = false;
      const first = old.points.slice(0, hit.segment.index + 1), second = old.points.slice(hit.segment.index + 1);
      if (distance(first[first.length - 1], hit.p)) first.push(hit.p);
      if (distance(second[0], hit.p)) second.unshift(hit.p);
      introduced.push(...addPath({ start: old.start, end: to, points: first }), ...addPath({ start: to, end: old.end, points: second }));
    }
    active.delete(hit.from); degree[hit.from]++; degree[to]++;
    introduced.push(...addPath({ start: hit.from, end: to, points: [graph.vertices[hit.from], graph.vertices[to]] }));
    closed.push({ from: graph.vertices[hit.from], to: graph.vertices[to] });
    // Only terminals near changed segments need new nearest candidates. Stale hits elsewhere are lazily discarded.
    const affected = new Set<number>();
    for (const segment of introduced) cells(segment.a, segment.b, maximumDistance, key => {
      for (const endpoint of endpointGrid.get(key) ?? []) if (active.has(endpoint)) affected.add(endpoint);
    });
    for (const endpoint of affected) enqueue(endpoint);
  }
  graph.paths = records.filter(record => record.active).map(record => record.path);
  return { graph, closed };
}

/** Douglas–Peucker returns source indices so curve fitting still measures against original pixels. */
export function simplifyPolyline(points: Vec2[], tolerance: number): number[] {
  if (points.length <= 2) return points.map((_, i) => i);
  const retained = new Set([0, points.length - 1]);
  const pending: [number, number][] = [[0, points.length - 1]];
  while (pending.length) {
    const [start, end] = pending.pop()!;
    let largest = tolerance;
    let selected = -1;
    for (let i = start + 1; i < end; i++) {
      const d = distance(points[i], projection(points[i], points[start], points[end]).p);
      if (d > largest) { largest = d; selected = i; }
    }
    if (selected >= 0) { retained.add(selected); pending.push([start, selected], [selected, end]); }
  }
  return [...retained].sort((a, b) => a - b);
}

export interface FittedCubic { start: Vec2; end: Vec2; c1: Vec2; c2: Vec2 }
const cubicPoint = (c: FittedCubic, t: number): Vec2 => {
  const u = 1 - t;
  return add(add(scale(c.start, u ** 3), scale(c.c1, 3 * u * u * t)), add(scale(c.c2, 3 * u * t * t), scale(c.end, t ** 3)));
};

function generateCubic(points: Vec2[], parameters: number[], left: Vec2, right: Vec2): FittedCubic {
  const start = points[0], end = points[points.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < points.length; i++) {
    const t = parameters[i], u = 1 - t;
    const b0 = u ** 3, b1 = 3 * t * u * u, b2 = 3 * t * t * u, b3 = t ** 3;
    const a0 = scale(left, b1), a1 = scale(right, b2);
    const residual = sub(points[i], add(scale(start, b0 + b1), scale(end, b2 + b3)));
    c00 += dot(a0, a0); c01 += dot(a0, a1); c11 += dot(a1, a1);
    x0 += dot(a0, residual); x1 += dot(a1, residual);
  }
  const determinant = c00 * c11 - c01 * c01;
  let alpha = determinant ? (x0 * c11 - x1 * c01) / determinant : 0;
  let beta = determinant ? (c00 * x1 - c01 * x0) / determinant : 0;
  const chord = distance(start, end);
  // Restrict wildly extended handles, a frequent cause of loops around narrow textile details.
  const arc = points.slice(1).reduce((length, p, i) => length + distance(p, points[i]), 0);
  if (alpha < 1e-6 * chord || beta < 1e-6 * chord || alpha > arc || beta > arc) alpha = beta = chord / 3;
  return { start, end, c1: add(start, scale(left, alpha)), c2: add(end, scale(right, beta)) };
}

function reparameterize(c: FittedCubic, p: Vec2, t: number): number {
  const u = 1 - t;
  const first = add(add(scale(sub(c.c1, c.start), 3 * u * u), scale(sub(c.c2, c.c1), 6 * u * t)), scale(sub(c.end, c.c2), 3 * t * t));
  const second = add(scale(add(sub(c.c2, scale(c.c1, 2)), c.start), 6 * u), scale(add(sub(c.end, scale(c.c2, 2)), c.c1), 6 * t));
  const residual = sub(cubicPoint(c, t), p);
  const denominator = dot(first, first) + dot(residual, second);
  return denominator ? Math.max(0, Math.min(1, t - dot(residual, first) / denominator)) : t;
}

/** Schneider least-squares cubic fitting with Newton refinement and maximum-error subdivision. */
export function fitCubicPolyline(points: Vec2[], maximumError: number, leftTangent?: Vec2, rightTangent?: Vec2): FittedCubic[] {
  if (points.length < 2) return [];
  const left = leftTangent ?? normalize(sub(points[Math.min(3, points.length - 1)], points[0]));
  const right = rightTangent ?? normalize(sub(points[Math.max(0, points.length - 4)], points[points.length - 1]));
  if (points.length === 2) return [{ start: points[0], end: points[1], c1: add(points[0], scale(left, distance(points[0], points[1]) / 3)), c2: add(points[1], scale(right, distance(points[0], points[1]) / 3)) }];
  let parameters = [0];
  for (let i = 1; i < points.length; i++) parameters.push(parameters[i - 1] + distance(points[i - 1], points[i]));
  const total = parameters[parameters.length - 1];
  if (!total) return [];
  parameters = parameters.map(t => t / total);
  let split = Math.floor(points.length / 2);
  for (let attempt = 0; attempt < 5; attempt++) {
    const curve = generateCubic(points, parameters, left, right);
    let error = -1;
    for (let i = 1; i < points.length - 1; i++) {
      const d = distance(points[i], cubicPoint(curve, parameters[i]));
      if (d > error) { error = d; split = i; }
    }
    if (error <= maximumError) return [curve];
    if (error > maximumError * 4) break;
    const refined = parameters.map((t, i) => i && i < points.length - 1 ? reparameterize(curve, points[i], t) : t);
    if (refined.some((t, i) => i > 0 && t <= refined[i - 1])) break;
    parameters = refined;
  }
  split = Math.max(1, Math.min(points.length - 2, split));
  // A one-pixel tangent follows raster stair steps rather than the underlying curve.
  // A short symmetric window keeps subdivision smooth while the fit still checks every source point.
  const tangentWindow = Math.min(3, split, points.length - split - 1);
  const center = normalize(sub(points[split - tangentWindow], points[split + tangentWindow]));
  return [...fitCubicPolyline(points.slice(0, split + 1), maximumError, left, center),
    ...fitCubicPolyline(points.slice(split), maximumError, scale(center, -1), right)];
}

function graphToGeometry(graph: SkeletonGraph, params: TraceParams, sourceWidths: number[]): { geometry: Geometry; objects: DesignObject[]; totalLength: number } {
  const geometry: Geometry = { nodes: {}, edges: {}, faceColors: {} };
  const byCoordinate = new Map<string, string>();
  let nodeSequence = 0;
  let edgeSequence = 0;
  const graphDegrees = degrees(graph);
  const node = (p: Vec2, kind: 'corner' | 'smooth'): string => {
    const q = point(p), key = `${q.x},${q.y}`;
    let id = byCoordinate.get(key);
    if (!id) { id = `n${++nodeSequence}`; byCoordinate.set(key, id); geometry.nodes[id] = { id, p: q, kind }; }
    else if (kind === 'corner') geometry.nodes[id].kind = 'corner';
    return id;
  };
  let totalLength = 0;
  for (let pathIndex = 0; pathIndex < graph.paths.length; pathIndex++) {
    const path = graph.paths[pathIndex];
    const points = path.points;
    if (points.length < 2) continue;
    totalLength += pathLength(path);
    const simplified = simplifyPolyline(points, params.simplifyTolerance);
    const closed = path.start === path.end;
    const last = points.length - 1;
    const corners = new Set<number>();
    if (!closed || graphDegrees[path.start] > 2) { corners.add(0); corners.add(last); }
    const turningAngle = (before: Vec2, at: Vec2, after: Vec2): number =>
      Math.acos(Math.max(-1, Math.min(1, dot(normalize(sub(at, before)), normalize(sub(after, at)))))) * 180 / Math.PI;
    for (let j = 1; j < simplified.length - 1; j++) {
      const i = simplified[j];
      if (turningAngle(points[simplified[j - 1]], points[i], points[simplified[j + 1]]) >= params.cornerAngleDeg) corners.add(i);
    }
    if (closed && simplified.length > 3 && turningAngle(points[simplified[simplified.length - 2]], points[0], points[simplified[1]]) >= params.cornerAngleDeg) {
      corners.add(0); corners.add(last);
    }
    const boundaries = new Set([0, last, ...corners]);
    if (closed && boundaries.size === 2) boundaries.add(Math.floor(last / 2));
    const breaks = [...boundaries].sort((a, b) => a - b);
    const boundaryTangent = (i: number, direction: 1 | -1): Vec2 | undefined => {
      if (corners.has(i)) return undefined;
      const before = points[closed ? (i - 3 + last) % last : Math.max(0, i - 3)];
      const after = points[closed ? (i + 3) % last : Math.min(last, i + 3)];
      return scale(normalize(sub(after, before)), direction);
    };
    const nodeIds: string[] = [];
    const segments: BezierSegment[] = [];
    for (let j = 0; j < breaks.length - 1; j++) {
      const fitted = fitCubicPolyline(points.slice(breaks[j], breaks[j + 1] + 1), params.fitMaxError,
        boundaryTangent(breaks[j], 1), boundaryTangent(breaks[j + 1], -1));
      for (let k = 0; k < fitted.length; k++) {
        const curve = fitted[k];
        if (!nodeIds.length) nodeIds.push(node(curve.start, corners.has(breaks[j]) ? 'corner' : 'smooth'));
        const id = node(curve.end, k === fitted.length - 1 && corners.has(breaks[j + 1]) ? 'corner' : 'smooth');
        if (id === nodeIds[nodeIds.length - 1]) continue;
        nodeIds.push(id);
        segments.push({ c1: point(curve.c1), c2: point(curve.c2) });
      }
    }
    if (nodeIds.length >= 2) {
      const id = `e${++edgeSequence}`;
      geometry.edges[id] = { id, nodeIds, segments, width: sourceWidths[pathIndex], widthMode: 'design', strokeHidden: false, colorIndex: 5, z: 0 };
    }
  }
  const edgeIds = Object.keys(geometry.edges);
  const edgesForNode = new Map<string, string[]>();
  for (const id of edgeIds) for (const n of geometry.edges[id].nodeIds) {
    const edges = edgesForNode.get(n) ?? []; edges.push(id); edgesForNode.set(n, edges);
  }
  const visited = new Set<string>();
  const components: { edgeIds: string[]; topLeft: Vec2 }[] = [];
  for (const seed of edgeIds) {
    if (visited.has(seed)) continue;
    const ids = [seed]; visited.add(seed);
    let topLeft = { x: Infinity, y: Infinity };
    for (let i = 0; i < ids.length; i++) for (const n of geometry.edges[ids[i]].nodeIds) {
      const p = geometry.nodes[n].p;
      if (readingOrder(p, topLeft) < 0) topLeft = p;
      for (const neighbor of edgesForNode.get(n)!) if (!visited.has(neighbor)) { visited.add(neighbor); ids.push(neighbor); }
    }
    components.push({ edgeIds: ids, topLeft });
  }
  components.sort((a, b) => readingOrder(a.topLeft, b.topLeft));
  const objects = components.map((c, i): DesignObject => ({ id: `o${i + 1}`, name: `Object ${i + 1}`, edgeIds: c.edgeIds, hidden: false, locked: false }));
  return { geometry, objects, totalLength };
}

export function traceImage(input: RasterInput, overrides: Partial<TraceParams> = {}): TraceResult {
  assertRaster(input);
  const area = input.width * input.height;
  const params: TraceParams = {
    threshold: 'otsu', invert: false,
    // The spec's area-scaled threshold removes whole tiny motifs at 4K. Keep master detail by default.
    minSpeckArea: Math.min(16, Math.max(4, area * 0.0001)),
    gapClosePx: Math.max(input.width, input.height) * 0.002,
    spurPrunePx: 0, simplifyTolerance: 1, fitMaxError: 1.5, cornerAngleDeg: 60,
    ...overrides,
  };
  for (const key of ['minSpeckArea', 'gapClosePx', 'spurPrunePx', 'simplifyTolerance', 'fitMaxError', 'cornerAngleDeg'] as const)
    if (!Number.isFinite(params[key]) || params[key] < 0) throw new Error(`${key} must be finite and non-negative.`);
  if (params.fitMaxError === 0) throw new Error('fitMaxError must be greater than zero.');
  if (params.cornerAngleDeg > 180) throw new Error('cornerAngleDeg must be at most 180.');
  const thresholded = binarize(input, params.threshold, params.invert);
  const cleaned = despeckle(thresholded.binary, input.width, input.height, params.minSpeckArea);
  const skeleton = skeletonize(cleaned, input.width, input.height);
  const lineWidthEstimate = estimateLineWidth(cleaned, skeleton, input.width, input.height);
  const extracted = extractSkeletonGraph(skeleton, input.width, input.height);
  const pruned = pruneSpurs(extracted, params.spurPrunePx);
  const repaired = closeGaps(pruned.graph, params.gapClosePx);
  const borderExtended = extendSourceBorderEnds(repaired.graph, thresholded.binary, input.width, input.height, lineWidthEstimate);
  const sourceStrokes = estimatePathStrokeWidths(borderExtended.graph, thresholded.binary, input.width, input.height, lineWidthEstimate);
  const { geometry, objects, totalLength } = graphToGeometry(borderExtended.graph, params, sourceStrokes.widths);
  const degree = degrees(borderExtended.graph);
  const openEnds = borderExtended.graph.vertices.filter((_, i) => degree[i] === 1).sort(readingOrder);
  const possibleTips = findPossibleTipSpurs(borderExtended.graph, lineWidthEstimate);
  const warnings: string[] = [];
  warnings.push('Visible traced strokes use a separate median source-ink cross-section width for each edge, measured in design pixels. Width is constant within each edge; original taper is approximated.');
  if (sourceStrokes.inherited) warnings.push(`${sourceStrokes.inherited} short or repaired edge widths could not be measured directly and use neighboring source widths or a corrected global fallback.`);
  if (overrides.minSpeckArea === undefined && Math.max(4, area * 0.0001) > 16)
    warnings.push('Master-preserving default: despeckle area is capped at 16 source pixels; the v1 specification scales it with image area.');
  if (overrides.spurPrunePx === undefined)
    warnings.push('Master-preserving default: automatic spur pruning is off. Minor detail removal belongs to an inspected size variant.');
  if (borderExtended.extended.length) warnings.push(`Info: ${borderExtended.extended.length} source-border line ends extended to the repeat cell boundary through verified source ink. Opposite repeat cuts must match.`);
  if (openEnds.length) warnings.push(`${openEnds.length} open line ends need review; intentional detail strokes may remain open.`);
  if (possibleTips.length) warnings.push(`${possibleTips.length} open ends are short sharp-tip branches that may be skeletonization artifacts. They are preserved for review, not treated as confirmed gaps.`);
  if (!Object.keys(geometry.edges).length) warnings.push('No traceable line paths found. Check threshold and input contrast.');
  return { geometry, objects, params, report: {
    threshold: thresholded.threshold, lineWidthEstimate, nodes: Object.keys(geometry.nodes).length,
    edges: Object.keys(geometry.edges).length, objects: objects.length, faces: 0, openEnds,
    autoClosed: repaired.closed, spursPruned: pruned.pruned,
    nodesPer1000du: totalLength ? snap(Object.keys(geometry.nodes).length * 1000 / totalLength) : 0,
    warnings,
  } };
}
