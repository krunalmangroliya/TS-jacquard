import type { Bounds, Edge, Face, FaceColor, Geometry, Repeat, TopologyResult, Vec2 } from './types';

const SCALE = 64;
const pointKey = (p: Vec2): string => `${p.x},${p.y}`;
const comparePoints = (a: Vec2, b: Vec2): number => a.x - b.x || a.y - b.y;
const samePoint = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;
const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const midpoint = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function distanceToSegmentSquared(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
}

/** Adaptive de Casteljau subdivision. The result includes both edge endpoints. */
export function flattenEdge(edge: Edge, geometry: Geometry, tolerance = 0.05): Vec2[] {
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) throw new Error('Flattening tolerance must be positive.');
  const points: Vec2[] = [];
  function cubic(a: Vec2, b: Vec2, c: Vec2, d: Vec2, depth: number): void {
    if (depth >= 20 || Math.max(distanceToSegmentSquared(b, a, d), distanceToSegmentSquared(c, a, d)) <= tolerance * tolerance) {
      points.push({ ...d }); return;
    }
    const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
    const abc = midpoint(ab, bc), bcd = midpoint(bc, cd), mid = midpoint(abc, bcd);
    cubic(a, ab, abc, mid, depth + 1); cubic(mid, bcd, cd, d, depth + 1);
  }
  for (let i = 0; i < edge.nodeIds.length - 1; i++) {
    const a = geometry.nodes[edge.nodeIds[i]]?.p, d = geometry.nodes[edge.nodeIds[i + 1]]?.p;
    if (!a || !d) throw new Error(`Edge ${edge.id} refers to a missing node.`);
    const segment = edge.segments[i] ?? {};
    for (const p of [a, d, segment.c1, segment.c2]) {
      if (p && (!Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error(`Edge ${edge.id} contains a non-finite coordinate.`);
    }
    if (i === 0) points.push({ ...a });
    if (!segment.c1 && !segment.c2) points.push({ ...d });
    else cubic(a, segment.c1 ?? a, segment.c2 ?? d, d, 0);
  }
  return points;
}

interface Segment { a: Vec2; b: Vec2; virtual: boolean }
function segmentKey(s: Segment): string { return `${pointKey(s.a)}:${pointKey(s.b)}`; }
function uniqueSegments(segments: Segment[]): Segment[] {
  const unique = new Map<string, Segment>();
  for (const original of segments) {
    if (samePoint(original.a, original.b)) continue;
    const s = comparePoints(original.a, original.b) <= 0 ? original : { ...original, a: original.b, b: original.a };
    const key = segmentKey(s), existing = unique.get(key);
    if (existing) existing.virtual = existing.virtual && s.virtual;
    else unique.set(key, { ...s });
  }
  return [...unique.values()].sort((a, b) => comparePoints(a.a, b.a) || comparePoints(a.b, b.b));
}

function clipSegment(a: Vec2, b: Vec2, w: number, h: number): [Vec2, Vec2] | undefined {
  let low = 0, high = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x], [dx, w - a.x], [-dy, a.y], [dy, h - a.y]]) {
    if (p === 0) { if (q < 0) return undefined; }
    else if (p < 0) low = Math.max(low, q / p);
    else high = Math.min(high, q / p);
    if (low > high) return undefined;
  }
  return [
    { x: Math.max(0, Math.min(w, Math.round(a.x + low * dx))), y: Math.max(0, Math.min(h, Math.round(a.y + low * dy))) },
    { x: Math.max(0, Math.min(w, Math.round(a.x + high * dx))), y: Math.max(0, Math.min(h, Math.round(a.y + high * dy))) },
  ];
}

function segmentIntersections(a: Segment, b: Segment): Vec2[] {
  if (Math.max(a.a.x, a.b.x) < Math.min(b.a.x, b.b.x) || Math.max(b.a.x, b.b.x) < Math.min(a.a.x, a.b.x)
    || Math.max(a.a.y, a.b.y) < Math.min(b.a.y, b.b.y) || Math.max(b.a.y, b.b.y) < Math.min(a.a.y, a.b.y)) return [];
  const r = sub(a.b, a.a), s = sub(b.b, b.a), q = sub(b.a, a.a), denominator = cross(r, s);
  if (denominator === 0) {
    if (cross(q, r) !== 0) return [];
    const within = (p: Vec2, t: Segment): boolean => p.x >= Math.min(t.a.x, t.b.x) && p.x <= Math.max(t.a.x, t.b.x)
      && p.y >= Math.min(t.a.y, t.b.y) && p.y <= Math.max(t.a.y, t.b.y);
    return [a.a, a.b, b.a, b.b].filter(p => within(p, a) && within(p, b));
  }
  const t = cross(q, s) / denominator, u = cross(q, r) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return [];
  return [{ x: Math.round(a.a.x + t * r.x), y: Math.round(a.a.y + t * r.y) }];
}

/** Re-arrange after snapping: a snapped crossing can bend a segment onto another one. */
function arrange(input: Segment[], warnings: string[]): Segment[] {
  let segments = uniqueSegments(input);
  for (let pass = 0; pass < 8; pass++) {
    // Most flattened segments already meet only at their endpoints. Allocate
    // split maps only for actual interior cuts instead of one Map per segment.
    const splits: (Map<string,Vec2>|undefined)[] = new Array(segments.length);
    let changed=false;
    const addSplit=(i:number,p:Vec2):void=>{const segment=segments[i];if(samePoint(p,segment.a)||samePoint(p,segment.b))return;(splits[i]??=new Map()).set(pointKey(p),p);changed=true;};
    const buckets = new Map<string, number[]>();
    const bucketSize = 64 * SCALE;
    const boxes = segments.map(s => ({ minX: s.a.x, maxX: s.b.x, minY: Math.min(s.a.y, s.b.y), maxY: Math.max(s.a.y, s.b.y) }));
    const home = boxes.map(box => ({ x: Math.floor(box.minX / bucketSize), y: Math.floor(box.minY / bucketSize) }));
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i], box = boxes[i];
      const x0 = home[i].x, x1 = Math.floor(box.maxX / bucketSize);
      const y0 = home[i].y, y1 = Math.floor(box.maxY / bucketSize);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const key = `${x},${y}`, bucket = buckets.get(key) ?? [];
        const active: number[] = [];
        for (const j of bucket) {
          const other = boxes[j];
          // Segments are sorted by minimum X. Expired entries cannot overlap
          // this segment or any later one and can leave the bucket permanently.
          if (other.maxX < box.minX) continue;
          active.push(j);
          if (other.maxY < box.minY || other.minY > box.maxY) continue;
          // Each overlapping pair belongs to its first shared bucket. This
          // avoids the unbounded global pair Set on dense textile panels.
          if (x !== Math.max(home[i].x, home[j].x) || y !== Math.max(home[i].y, home[j].y)) continue;
          for (const p of segmentIntersections(segments[j], s)) {
            addSplit(i,p);addSplit(j,p);
          }
        }
        active.push(i); buckets.set(key, active);
      }
    }
    if(!changed)return segments;
    const split: Segment[] = [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i], d = sub(s.b, s.a);
      if(!splits[i]){split.push(s);continue;}
      const points = [s.a,s.b,...splits[i]!.values()].sort((a, b) => (a.x - b.x) * d.x + (a.y - b.y) * d.y || comparePoints(a, b));
      for (let j = 1; j < points.length; j++) split.push({ a: points[j - 1], b: points[j], virtual: s.virtual });
    }
    const next = uniqueSegments(split);
    if (next.length === segments.length && next.every((s, i) => samePoint(s.a,segments[i].a)&&samePoint(s.b,segments[i].b))) return next;
    segments = next;
  }
  warnings.push('Intersection snapping did not stabilize within eight passes; review very close crossings.');
  return segments;
}

export function polygonArea(points: Vec2[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) area += cross(points[j], points[i]);
  return area / 2;
}

interface PolygonBox { minX: number; minY: number; maxX: number; maxY: number }
interface BoxNode extends PolygonBox { children?: [BoxNode, BoxNode]; indices?: number[] }
/** Static median-split bounding-box tree. Queries retain original face order. */
class PolygonIndex {
  private root?: BoxNode;
  constructor(rings: Vec2[][]) {
    const boxes: PolygonBox[] = rings.map(ring => {
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const p of ring) { box.minX = Math.min(box.minX, p.x); box.minY = Math.min(box.minY, p.y); box.maxX = Math.max(box.maxX, p.x); box.maxY = Math.max(box.maxY, p.y); }
      return box;
    });
    function build(indices: number[]): BoxNode {
      const node: BoxNode = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      let centerMinX = Infinity, centerMinY = Infinity, centerMaxX = -Infinity, centerMaxY = -Infinity;
      for (const i of indices) {
        const box = boxes[i];
        node.minX = Math.min(node.minX, box.minX); node.minY = Math.min(node.minY, box.minY); node.maxX = Math.max(node.maxX, box.maxX); node.maxY = Math.max(node.maxY, box.maxY);
        const x = box.minX + box.maxX, y = box.minY + box.maxY;
        centerMinX = Math.min(centerMinX, x); centerMinY = Math.min(centerMinY, y); centerMaxX = Math.max(centerMaxX, x); centerMaxY = Math.max(centerMaxY, y);
      }
      if (indices.length <= 8) { node.indices = indices; return node; }
      const horizontal = centerMaxX - centerMinX >= centerMaxY - centerMinY;
      indices.sort((a, b) => horizontal ? boxes[a].minX + boxes[a].maxX - boxes[b].minX - boxes[b].maxX || a - b : boxes[a].minY + boxes[a].maxY - boxes[b].minY - boxes[b].maxY || a - b);
      const mid = indices.length >> 1;
      node.children = [build(indices.slice(0, mid)), build(indices.slice(mid))];
      return node;
    }
    if (rings.length) this.root = build(rings.map((_, i) => i));
    this.boxes = boxes;
  }
  private boxes: PolygonBox[];
  at(p: Vec2): number[] {
    const found: number[] = [], stack = this.root ? [this.root] : [];
    const contains = (box: PolygonBox): boolean => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
    while (stack.length) {
      const node = stack.pop()!; if (!contains(node)) continue;
      if (node.indices) { for (const i of node.indices) if (contains(this.boxes[i])) found.push(i); }
      else if (node.children) stack.push(node.children[1], node.children[0]);
    }
    return found.sort((a, b) => a - b);
  }
  /** Candidate boundary segments crossing the horizontal ray to the right. */
  ray(p: Vec2): number[] {
    const found:number[]=[],stack=this.root?[this.root]:[];
    const crosses=(box:PolygonBox)=>box.maxX>p.x&&box.minY<=p.y&&p.y<box.maxY;
    while(stack.length){const node=stack.pop()!;if(!crosses(node))continue;if(node.indices){for(const i of node.indices)if(crosses(this.boxes[i]))found.push(i);}else if(node.children)stack.push(node.children[1],node.children[0]);}
    return found;
  }
  /** Exact nearest segment distance; bounding boxes only discard provably farther candidates. */
  nearestSegmentDistanceSquared(p:Vec2,segments:Vec2[][]):number {
    const boxDistance=(box:PolygonBox)=>Math.max(box.minX-p.x,0,p.x-box.maxX)**2+Math.max(box.minY-p.y,0,p.y-box.maxY)**2;
    let best=Infinity;const stack:{node:BoxNode;distance:number}[]=this.root?[{node:this.root,distance:boxDistance(this.root)}]:[];
    while(stack.length){
      const {node,distance}=stack.pop()!;if(distance>best)continue;
      if(node.indices){for(const i of node.indices)if(boxDistance(this.boxes[i])<=best)best=Math.min(best,distanceToSegmentSquared(p,segments[i][0],segments[i][1]));}
      else if(node.children){const [a,b]=node.children,da=boxDistance(a),db=boxDistance(b);if(da<db){if(db<=best)stack.push({node:b,distance:db});if(da<=best)stack.push({node:a,distance:da});}else{if(da<=best)stack.push({node:a,distance:da});if(db<=best)stack.push({node:b,distance:db});}}
    }
    return best;
  }
}

/** Half-open ray test: left/top boundaries are included, right/bottom are excluded. */
export function pointInPolygon(p: Vec2, points: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function faceContains(face: Face, p: Vec2): boolean {
  return (!face.outer || pointInPolygon(p, face.outer)) && !face.holes.some(hole => pointInPolygon(p, hole));
}

export function faceAt(faces: Face[], p: Vec2): Face | undefined {
  // Bounded regions first also makes the ground's exclusion rings defensive.
  return faces.find(face => face.outer && faceContains(face, p)) ?? faces.find(face => !face.outer && faceContains(face, p));
}

function rightSample(ring: Vec2[], distance = 1e-6): Vec2 {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (length > 0) return { x: (a.x + b.x) / 2 - dy / length * distance, y: (a.y + b.y) / 2 + dx / length * distance };
  }
  return { ...ring[0] };
}

interface Cell { x: number; y: number; h: number; d: number; max: number }
function interiorReference(outer: Vec2[], holes: Vec2[][]): Vec2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outer) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const rings = [outer, ...holes];
  // Large panel grounds can contain hundreds of thousands of boundary segments.
  // The reference search visits the same boundaries many times; index them once.
  const segmentCount=rings.reduce((sum,ring)=>sum+ring.length,0),segments:Vec2[][]=[],segmentRings:number[]=[];
  if(segmentCount>128)rings.forEach((ring,r)=>{for(let i=0,j=ring.length-1;i<ring.length;j=i++){segments.push([ring[j],ring[i]]);segmentRings.push(r);}});
  const boundaryIndex=segments.length?new PolygonIndex(segments):undefined;
  function signedDistance(p: Vec2): number {
    if(boundaryIndex){
      const distance=boundaryIndex.nearestSegmentDistanceSquared(p,segments),insideRings=new Set<number>();
      for(const i of boundaryIndex.ray(p)){const [a,b]=segments[i];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x){const ring=segmentRings[i];if(insideRings.has(ring))insideRings.delete(ring);else insideRings.add(ring);}}
      return (insideRings.size===1&&insideRings.has(0)?1:-1)*Math.sqrt(distance);
    }
    let distance = Infinity;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) distance = Math.min(distance, distanceToSegmentSquared(p, ring[j], ring[i]));
    const inside = pointInPolygon(p, outer) && !holes.some(hole => pointInPolygon(p, hole));
    return (inside ? 1 : -1) * Math.sqrt(distance);
  }
  const make = (x: number, y: number, h: number): Cell => { const d = signedDistance({ x, y }); return { x, y, h, d, max: d + h * Math.SQRT2 }; };
  const heap: Cell[] = [];
  function push(cell: Cell): void {
    heap.push(cell); let i = heap.length - 1;
    while (i > 0) { const parent = (i - 1) >> 1; if (heap[parent].max >= cell.max) break; heap[i] = heap[parent]; i = parent; }
    heap[i] = cell;
  }
  function pop(): Cell {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].max > heap[child].max) child++;
        if (heap[child].max <= last.max) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return first;
  }
  const width = maxX - minX, height = maxY - minY;
  let best = make((minX + maxX) / 2, (minY + maxY) / 2, 0);
  const sample = rightSample(outer, 1e-7), sampleCell = make(sample.x, sample.y, 0);
  if (sampleCell.d > best.d) best = sampleCell;
  const size = Math.max(Math.min(width, height), Math.max(width, height) / 32);
  if (!(size > 0)) return { x: best.x, y: best.y };
  for (let x = minX; x < maxX; x += size) for (let y = minY; y < maxY; y += size) push(make(x + size / 2, y + size / 2, size / 2));
  const precision = Math.max(1 / 4096, Math.min(0.5, width / 8, height / 8));
  for (let count = 0; heap.length && count < 8192; count++) {
    const cell = pop();
    if (cell.d > best.d) best = cell;
    if (cell.max - best.d <= precision) continue;
    const h = cell.h / 2;
    push(make(cell.x - h, cell.y - h, h)); push(make(cell.x + h, cell.y - h, h));
    push(make(cell.x - h, cell.y + h, h)); push(make(cell.x + h, cell.y + h, h));
  }
  return { x: best.x, y: best.y };
}

function canonicalRing(ring: Vec2[], offset: Vec2 = { x: 0, y: 0 }): string {
  let start = 0;
  for (let i = 1; i < ring.length; i++) if (comparePoints(ring[i], ring[start]) < 0) start = i;
  return ring.map((_, i) => { const p = ring[(start + i) % ring.length]; return `${Math.round((p.x - offset.x) * SCALE)},${Math.round((p.y - offset.y) * SCALE)}`; }).join(';');
}

function hash(value: string): string {
  let a = 2166136261, b = 2246822519;
  for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); a = Math.imul(a ^ code, 16777619); b = Math.imul(b ^ code, 3266489917); }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

class UnionFind {
  private parents: number[];
  constructor(length: number) { this.parents = Array.from({ length }, (_, i) => i); }
  find(i: number): number { let root = i; while (this.parents[root] !== root) root = this.parents[root]; while (this.parents[i] !== i) { const next = this.parents[i]; this.parents[i] = root; i = next; } return root; }
  union(a: number, b: number): void { a = this.find(a); b = this.find(b); if (a !== b) this.parents[Math.max(a, b)] = Math.min(a, b); }
}

interface BorderInterval { start: number; end: number; face: number }
function borders(ring: Vec2[], w: number, h: number, face: number): BorderInterval[][] {
  const result: BorderInterval[][] = [[], [], [], []];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const side = a.x === 0 && b.x === 0 ? 0 : a.x === w && b.x === w ? 1 : a.y === 0 && b.y === 0 ? 2 : a.y === h && b.y === h ? 3 : -1;
    if (side >= 0) { const va = side < 2 ? a.y : a.x, vb = side < 2 ? b.y : b.x; if (va !== vb) result[side].push({ start: Math.min(va, vb), end: Math.max(va, vb), face }); }
  }
  return result;
}

/**
 * Pure integer arrangement with a virtual rectangular cell boundary. Virtual
 * edges are necessary to close clipped faces; they are never user geometry.
 * Statistics include this virtual border and exclude the outside-cell face:
 * V - E + faces.length = components (the bounded-cell Euler relation).
 */
export function buildPlanarMap(geometry: Geometry, bounds: Bounds, repeat: Repeat = { type: 'straight' }): TopologyResult {
  if (!(bounds.w > 0 && bounds.h > 0) || !Number.isFinite(bounds.w) || !Number.isFinite(bounds.h)) throw new Error('Topology bounds must be finite and positive.');
  if (bounds.w > 1_000_000 || bounds.h > 1_000_000) throw new Error('Topology bounds exceed the supported fixed-point range.');
  const warnings: string[] = [];
  if (repeat.type !== 'straight' && repeat.type !== 'none') warnings.push(`${repeat.type} seam editing is not implemented; topology uses straight repeat. Use straight repeat for export.`);
  const w = Math.round(bounds.w * SCALE), h = Math.round(bounds.h * SCALE);
  if (w < 1 || h < 1) throw new Error('Topology bounds are smaller than the fixed-point grid.');
  const source: Segment[] = [];
  for (const key of Object.keys(geometry.edges).sort()) {
    const edge = geometry.edges[key], points = flattenEdge(edge, geometry).map(p => ({ x: Math.round(p.x * SCALE), y: Math.round(p.y * SCALE) }));
    if (points.some(p => !Number.isSafeInteger(p.x) || !Number.isSafeInteger(p.y))) throw new Error(`Edge ${edge.id} exceeds the supported fixed-point coordinate range.`);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      // Compute relevant translations rather than assuming an object stayed
      // within the immediately neighboring eight cells after a move.
      const x0 = repeat.type === 'none' ? 0 : Math.ceil(-Math.max(a.x, b.x) / w), x1 = repeat.type === 'none' ? 0 : Math.floor((w - Math.min(a.x, b.x)) / w);
      const y0 = repeat.type === 'none' ? 0 : Math.ceil(-Math.max(a.y, b.y) / h), y1 = repeat.type === 'none' ? 0 : Math.floor((h - Math.min(a.y, b.y)) / h);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) throw new Error(`Edge ${edge.id} spans too many repeat cells.`);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const clipped = clipSegment({ x: a.x + x * w, y: a.y + y * h }, { x: b.x + x * w, y: b.y + y * h }, w, h);
        if (clipped && !samePoint(clipped[0], clipped[1])) source.push({ a: clipped[0], b: clipped[1], virtual: false });
      }
    }
  }
  const corners = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  for (let i = 0; i < 4; i++) source.push({ a: corners[i], b: corners[(i + 1) % 4], virtual: true });
  const segments = arrange(source, warnings), vertices: Vec2[] = [], vertexIds = new Map<string, number>();
  const getVertex = (p: Vec2): number => { const key = pointKey(p); let id = vertexIds.get(key); if (id === undefined) { id = vertices.length; vertexIds.set(key, id); vertices.push(p); } return id; };
  const starts: number[] = [], ends: number[] = [], outgoing: number[][] = [];
  for (const s of segments) {
    const a = getVertex(s.a), b = getVertex(s.b), index = starts.length;
    starts.push(a, b); ends.push(b, a);
    (outgoing[a] ??= []).push(index); (outgoing[b] ??= []).push(index + 1);
  }
  const order: number[] = [];
  for (let vertex = 0; vertex < outgoing.length; vertex++) {
    const p = vertices[vertex];
    outgoing[vertex].sort((a, b) => {
      const da = sub(vertices[ends[a]], p), db = sub(vertices[ends[b]], p);
      const halfA = da.y > 0 || (da.y === 0 && da.x >= 0) ? 0 : 1;
      const halfB = db.y > 0 || (db.y === 0 && db.x >= 0) ? 0 : 1;
      return halfA - halfB || -cross(da, db) || a - b;
    });
    outgoing[vertex].forEach((edge, i) => { order[edge] = i; });
  }
  const visited = new Uint8Array(starts.length), positive: Vec2[][] = [], negative: Vec2[][] = [];
  for (let start = 0; start < starts.length; start++) {
    if (visited[start]) continue;
    const ring: Vec2[] = []; let current = start;
    do {
      if (visited[current]) { warnings.push('A half-edge cycle could not be closed; review the traced junction.'); break; }
      visited[current] = 1; ring.push(vertices[starts[current]]);
      const candidates = outgoing[ends[current]], reversePosition = order[current ^ 1];
      current = candidates[(reversePosition + candidates.length - 1) % candidates.length];
    } while (current !== start && ring.length <= starts.length);
    const area = polygonArea(ring);
    if (area > 0) positive.push(ring); else if (area < 0) negative.push(ring);
  }
  const faces: Face[] = positive.map(ring => {
    const outer = ring.map(p => ({ x: p.x / SCALE, y: p.y / SCALE }));
    return { id: '', outer, holes: [], areaDu: polygonArea(outer), ref: { x: 0, y: 0 } };
  });
  const positiveAreas = positive.map(polygonArea), positiveIndex = new PolygonIndex(positive);
  for (const hole of negative) {
    const sample = rightSample(hole, 1e-5);
    let owner = -1, area = Infinity;
    for (const i of positiveIndex.at(sample)) {
      const candidateArea = positiveAreas[i];
      if (candidateArea < area && pointInPolygon(sample, positive[i])) { owner = i; area = candidateArea; }
    }
    if (owner >= 0) faces[owner].holes.push(hole.map(p => ({ x: p.x / SCALE, y: p.y / SCALE })));
  }
  for (const face of faces) {
    face.holes.sort((a, b) => { const ka = canonicalRing(a), kb = canonicalRing(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
    face.areaDu -= face.holes.reduce((sum, hole) => sum + Math.abs(polygonArea(hole)), 0);
    face.ref = interiorReference(face.outer!, face.holes);
    face.id = `face-${hash(canonicalRing(face.outer!) + '|' + face.holes.map(hole => canonicalRing(hole)).join('|'))}`;
  }
  // The topology pass stays within the cell. Only virtual seam intervals join
  // faces; an actual design edge lying on the seam remains a boundary.
  const seams = new UnionFind(faces.length), sides: BorderInterval[][] = [[], [], [], []], realSides: BorderInterval[][] = [[], [], [], []];
  faces.forEach((face, i) => {
    for (const ring of [face.outer!, ...face.holes]) borders(ring, w / SCALE, h / SCALE, i).forEach((intervals, side) => sides[side].push(...intervals));
  });
  for (const s of segments) if (!s.virtual) borders([s.a, s.b], w, h, -1).forEach((intervals, side) => realSides[side].push(...intervals.map(interval => ({ ...interval, start: interval.start / SCALE, end: interval.end / SCALE }))));
  for (const [left, right] of repeat.type === 'none' ? [] : [[0, 1], [2, 3]]) for (const a of sides[left]) for (const b of sides[right]) {
    const low = Math.max(a.start, b.start), high = Math.min(a.end, b.end);
    if (high <= low) continue;
    const barriers = [...realSides[left], ...realSides[right]].filter(interval => interval.start < high && interval.end > low).sort((a, b) => a.start - b.start || a.end - b.end);
    let covered = low, hasOpenInterval = false;
    for (const barrier of barriers) { if (barrier.start > covered) { hasOpenInterval = true; break; } covered = Math.max(covered, barrier.end); }
    if (hasOpenInterval || covered < high) seams.union(a.face, b.face);
  }
  const groupArea = new Map<number, number>(), groupBoundary = new Map<number, number>();
  const groupMembers = new Map<number, number[]>();
  faces.forEach((face, i) => {
    const group = seams.find(i); groupArea.set(group, (groupArea.get(group) ?? 0) + face.areaDu);
    const members = groupMembers.get(group) ?? []; members.push(i); groupMembers.set(group, members);
  });
  for (const side of sides) for (const interval of side) { const group = seams.find(interval.face); groupBoundary.set(group, (groupBoundary.get(group) ?? 0) + interval.end - interval.start); }
  const groups = [...groupArea.keys()].sort((a, b) => (groupBoundary.get(b) ?? 0) - (groupBoundary.get(a) ?? 0) || groupArea.get(b)! - groupArea.get(a)! || a - b);
  const groundGroup = groups[0], groundCandidates = faces.map((face, i) => ({ face, i })).filter(({ i }) => seams.find(i) === groundGroup).sort((a, b) => b.face.areaDu - a.face.areaDu || a.i - b.i);
  const groundIndex = groundCandidates[0]?.i ?? -1;
  if (groundIndex < 0) throw new Error('Topology did not produce a valid cell face.');
  const groupIds = new Map<number, string>();
  for (const group of groups) groupIds.set(group, group === groundGroup ? 'ground' : `seam-${hash(groupMembers.get(group)!.map(i => faces[i].id).sort().join('|'))}`);
  faces.forEach((face, i) => { face.seamGroup = groupIds.get(seams.find(i)); });
  const ground = faces[groundIndex];
  ground.holes = faces.filter((_, i) => i !== groundIndex).map(face => face.outer!).filter(ring => {
    const sample = rightSample(ring), ringArea = Math.abs(polygonArea(ring));
    return !positiveIndex.at({ x: sample.x * SCALE, y: sample.y * SCALE }).some(j => j !== groundIndex && positiveAreas[j] / (SCALE * SCALE) > ringArea && pointInPolygon(sample, faces[j].outer!));
  });
  ground.outer = null; ground.id = 'ground';
  faces.sort((a, b) => a.id === 'ground' ? -1 : b.id === 'ground' ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const components = new UnionFind(vertices.length);
  for (let i = 0; i < starts.length; i += 2) components.union(starts[i], ends[i]);
  return { faces, warnings, vertices: vertices.length, segments: segments.length, components: new Set(vertices.map((_, i) => components.find(i))).size };
}

function translationSignature(face: Face): string | undefined {
  if (!face.outer) return undefined;
  const offset = { x: Infinity, y: Infinity };
  for (const p of face.outer) { offset.x = Math.min(offset.x, p.x); offset.y = Math.min(offset.y, p.y); }
  return `${canonicalRing(face.outer, offset)}|${face.holes.map(hole => canonicalRing(hole, offset)).sort().join('|')}`;
}

interface LabelSpace { x: number; y: number; scale: number; w: number; h: number }
function labelSpace(faces: Face[]): LabelSpace {
  let minX = 0, minY = 0, maxX = 1, maxY = 1;
  for (const face of faces) for (const ring of [...(face.outer ? [face.outer] : []), ...face.holes]) for (const p of ring) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const scale = 1024 / Math.max(maxX - minX, maxY - minY);
  return { x: minX, y: minY, scale, w: Math.max(1, Math.ceil((maxX - minX) * scale)), h: Math.max(1, Math.ceil((maxY - minY) * scale)) };
}

function rasterLabels(faces: Face[], space: LabelSpace): Uint32Array {
  const result = new Uint32Array(space.w * space.h), ground = faces.findIndex(face => !face.outer);
  if (ground >= 0) result.fill(ground + 1);
  for (let index = 0; index < faces.length; index++) {
    const face = faces[index]; if (!face.outer) continue;
    const rings = [face.outer, ...face.holes]; let minY = Infinity, maxY = -Infinity;
    for (const p of face.outer) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const start = Math.max(0, Math.ceil((minY - space.y) * space.scale - 0.5)), end = Math.min(space.h, Math.ceil((maxY - space.y) * space.scale - 0.5));
    for (let y = start; y < end; y++) {
      const py = space.y + (y + 0.5) / space.scale, crossings: number[] = [];
      for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        if ((a.y > py) !== (b.y > py)) crossings.push(a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y));
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const x0 = Math.max(0, Math.ceil((crossings[i] - space.x) * space.scale - 0.5)), x1 = Math.min(space.w, Math.ceil((crossings[i + 1] - space.x) * space.scale - 0.5));
        result.fill(index + 1, y * space.w + x0, y * space.w + x1);
      }
    }
  }
  return result;
}

/**
 * Reconcile persisted assignments after rebuilding deterministic topology.
 * Current IDs have priority, including an explicitly unassigned color. Stale
 * IDs fall back to their stored interior reference. No input is modified.
 */
export function resolveFaceColors(faces: Face[], persisted: Record<string, FaceColor>): { faceColors: Record<string, FaceColor>; warnings: string[] } {
  const faceColors: Record<string, FaceColor> = {}, warnings: string[] = [];
  const current = new Map(faces.map(face => [face.id, face]));
  type Candidate = { id: string; colorIndex: number | null; direct: boolean };
  const candidates = new Map<string, Candidate[]>();
  const compareKeys = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
  for (const [id, color] of Object.entries(persisted).sort(([a], [b]) => compareKeys(a, b))) {
    const direct = current.get(id), face = direct ?? faceAt(faces, color.ref);
    if (!face) { warnings.push(`Saved face ${id} could not be resolved from its reference point.`); continue; }
    const bucket = candidates.get(face.id) ?? [];
    bucket.push({ id, colorIndex: color.colorIndex, direct: direct !== undefined });
    candidates.set(face.id, bucket);
  }
  const authority = new Map<string, number>();
  for (const face of faces) {
    const bucket = (candidates.get(face.id) ?? []).sort((a, b) => Number(b.direct) - Number(a.direct) || compareKeys(a.id, b.id));
    const chosen = bucket[0];
    const colorIndex = chosen ? chosen.colorIndex : face.outer === null || face.seamGroup === 'ground' ? 0 : null;
    faceColors[face.id] = { colorIndex, ref: { ...face.ref } };
    authority.set(face.id, chosen ? chosen.direct ? 2 : 1 : 0);
    if (new Set(bucket.map(candidate => candidate.colorIndex)).size > 1) {
      warnings.push(`Conflicting saved colors for face ${face.id}; kept ${chosen.direct ? 'the current ID assignment' : `the reference assignment from ${chosen.id}`}.`);
    }
  }
  const seamGroups = new Map<string, Face[]>();
  for (const face of faces) if (face.seamGroup) { const bucket = seamGroups.get(face.seamGroup) ?? []; bucket.push(face); seamGroups.set(face.seamGroup, bucket); }
  for (const [groupId, group] of [...seamGroups].sort(([a], [b]) => compareKeys(a, b))) {
    // One fill colors an entire logical seam face. Unassigned/default pieces
    // must not override an explicitly colored piece. A direct ground color
    // wins ties so a recolored ground survives serialization and clipping.
    const assigned = group.filter(face => authority.get(face.id)! > 0 && faceColors[face.id].colorIndex !== null).sort((a, b) =>
      authority.get(b.id)! - authority.get(a.id)! || Number(b.id === 'ground') - Number(a.id === 'ground') || b.areaDu - a.areaDu || compareKeys(a.id, b.id));
    const explicitUnassigned = group.some(face => authority.get(face.id)! > 0 && faceColors[face.id].colorIndex === null);
    const selected = assigned.length ? faceColors[assigned[0].id].colorIndex : explicitUnassigned ? null : groupId === 'ground' ? 0 : null;
    if (new Set(assigned.map(face => faceColors[face.id].colorIndex)).size > 1) warnings.push(`Conflicting saved colors across repeat seam ${groupId}; kept the highest-priority assignment from ${assigned[0].id}.`);
    for (const face of group) faceColors[face.id].colorIndex = selected;
  }
  return { faceColors, warnings };
}

/**
 * Overlap tracking with a translation-invariant geometry match before sampling.
 * Exact translations and subpixel faces retain color without relying on a
 * 1024-pixel label map. Splits inherit; merges keep the largest prior region.
 */
export function trackFaces(prevFaces: Face[], prevColors: Record<string, FaceColor>, newFaces: Face[]): { faces: Face[]; faceColors: Record<string, FaceColor>; warnings: string[] } {
  const faces = newFaces.map(face => ({ ...face, ref: { ...face.ref } })), warnings: string[] = [], faceColors: Record<string, FaceColor> = {};
  if (prevFaces.length === 0) return { faces, ...resolveFaceColors(faces, prevColors) };
  const oldToNew = new Map<number, number>(), newToOld = new Map<number, number>();
  const assign = (oldIndex: number, newIndex: number): void => { oldToNew.set(oldIndex, newIndex); newToOld.set(newIndex, oldIndex); };
  const oldGround = prevFaces.findIndex(face => !face.outer), newGround = faces.findIndex(face => !face.outer);
  if (oldGround >= 0 && newGround >= 0) assign(oldGround, newGround);
  const signatures = new Map<string, number[]>();
  prevFaces.forEach((face, i) => { const signature = translationSignature(face); if (signature) { const bucket = signatures.get(signature) ?? []; bucket.push(i); signatures.set(signature, bucket); } });
  const exact: { old: number; next: number; distance: number }[] = [];
  faces.forEach((face, i) => { const signature = translationSignature(face); if (signature) for (const old of signatures.get(signature) ?? []) exact.push({ old, next: i, distance: (face.ref.x - prevFaces[old].ref.x) ** 2 + (face.ref.y - prevFaces[old].ref.y) ** 2 }); });
  exact.sort((a, b) => a.distance - b.distance || a.old - b.old || a.next - b.next);
  for (const candidate of exact) if (!oldToNew.has(candidate.old) && !newToOld.has(candidate.next)) assign(candidate.old, candidate.next);
  const overlaps = Array.from({ length: faces.length }, () => new Map<number, number>());
  // A complete exact one-to-one match already determines every ID and color.
  // Sampled overlaps cannot add a merge when no old region remains unmatched.
  if (prevFaces.length && faces.length && (oldToNew.size!==prevFaces.length||newToOld.size!==faces.length)) {
    const space = labelSpace([...prevFaces, ...faces]), before = rasterLabels(prevFaces, space), after = rasterLabels(faces, space);
    for (let i = 0; i < before.length; i++) if (before[i] && after[i]) { const row = overlaps[after[i] - 1], previous = before[i] - 1; row.set(previous, (row.get(previous) ?? 0) + 1); }
  }
  const ranked = overlaps.map(row => [...row].sort((a, b) => b[1] - a[1] || prevFaces[b[0]].areaDu - prevFaces[a[0]].areaDu || a[0] - b[0]));
  const candidates: { old: number; next: number; overlap: number }[] = [];
  ranked.forEach((row, next) => { for (const [old, overlap] of row) candidates.push({ old, next, overlap }); });
  candidates.sort((a, b) => b.overlap - a.overlap || a.old - b.old || a.next - b.next);
  for (const candidate of candidates) if (!oldToNew.has(candidate.old) && !newToOld.has(candidate.next)) assign(candidate.old, candidate.next);
  const takenIds = new Set<string>();
  faces.forEach((face, i) => {
    const matched = newToOld.get(i), parent = matched ?? ranked[i][0]?.[0];
    if (matched !== undefined) face.id = prevFaces[matched].id;
    // A content ID can equal one inherited by a different face after a split.
    const baseId = face.id; let suffix = 1; while (takenIds.has(face.id)) face.id = `${baseId}-${suffix++}`; takenIds.add(face.id);
    const prior = parent === undefined ? undefined : prevColors[prevFaces[parent].id];
    faceColors[face.id] = { colorIndex: prior?.colorIndex ?? (face.seamGroup === 'ground' || !face.outer ? 0 : null), ref: { ...face.ref } };
    const merged = ranked[i].map(([old]) => old).filter(old => !oldToNew.has(old) || oldToNew.get(old) === i);
    const colors = new Set(merged.map(old => prevColors[prevFaces[old].id]?.colorIndex).filter(color => color !== undefined && color !== null));
    if (colors.size > 1) {
      const largest = merged.sort((a, b) => prevFaces[b].areaDu - prevFaces[a].areaDu || a - b)[0];
      faceColors[face.id].colorIndex = prevColors[prevFaces[largest].id]?.colorIndex ?? faceColors[face.id].colorIndex;
      warnings.push(`Merged colors ${[...colors].sort((a, b) => a! - b!).join(', ')} at (${face.ref.x.toFixed(3)}, ${face.ref.y.toFixed(3)}); kept the larger region's color.`);
    }
  });
  // Reference fallback only fills unassigned faces; sampled tiny faces must
  // never overwrite a successfully tracked larger neighboring face.
  const currentIds=new Set(faces.map(face=>face.id));
  for (const [id, color] of Object.entries(prevColors).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (currentIds.has(id)) continue;
    const face = faceAt(faces, color.ref);
    if (face && faceColors[face.id].colorIndex === null) faceColors[face.id].colorIndex = color.colorIndex;
  }
  const seamGroups = new Map<string, Face[]>();
  for (const face of faces) if (face.seamGroup) { const group = seamGroups.get(face.seamGroup) ?? []; group.push(face); seamGroups.set(face.seamGroup, group); }
  for (const [groupId, group] of seamGroups) {
    const colored = group.filter(face => faceColors[face.id].colorIndex !== null).sort((a, b) => b.areaDu - a.areaDu || (a.id < b.id ? -1 : 1));
    if (!colored.length) continue;
    const color = faceColors[colored[0].id].colorIndex;
    if (new Set(colored.map(face => faceColors[face.id].colorIndex)).size > 1) warnings.push(`Conflicting colors across repeat seam ${groupId}; kept the larger region's color.`);
    for (const face of group) faceColors[face.id].colorIndex = color;
  }
  return { faces, faceColors, warnings };
}
