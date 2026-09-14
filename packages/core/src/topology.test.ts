import { describe, expect, it } from 'vitest';
import { buildPlanarMap, faceAt, flattenEdge, pointInPolygon, resolveFaceColors, trackFaces } from './topology';
import type { Bounds, Face, FaceColor, Geometry, Vec2 } from './types';

const bounds: Bounds = { w: 100, h: 100 };
function geometry(paths: number[][][]): Geometry {
  const result: Geometry = { nodes: {}, edges: {}, faceColors: {} };
  paths.forEach((path, i) => {
    const nodeIds = path.map(([x, y], j) => {
      const id = `n${i}-${j}`;
      result.nodes[id] = { id, p: { x, y }, kind: 'corner' };
      return id;
    });
    result.edges[`e${i}`] = { id: `e${i}`, nodeIds, segments: path.slice(1).map(() => ({})), width: 0, z: 0 };
  });
  return result;
}
const square = (x: number, y: number, size: number): number[][] => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
function colorMap(faces: Face[], color: (face: Face) => number | null): Record<string, FaceColor> {
  return Object.fromEntries(faces.map(face => [face.id, { colorIndex: color(face), ref: face.ref }]));
}
function validatePartition(faces: Face[], size = bounds): void {
  expect(faces.reduce((area, face) => area + face.areaDu, 0)).toBeCloseTo(size.w * size.h, 8);
  for (const face of faces) {
    expect(face.areaDu).toBeGreaterThan(0);
    expect(faceAt(faces, face.ref)?.id).toBe(face.id);
  }
  for (let y = 0.25; y < size.h; y += size.h / 19) for (let x = 0.25; x < size.w; x += size.w / 19) {
    const p = { x, y };
    const containing = faces.filter(face => (!face.outer || pointInPolygon(p, face.outer)) && !face.holes.some(hole => pointInPolygon(p, hole)));
    expect(containing, `partition at ${x},${y}`).toHaveLength(1);
  }
}

describe('integer topology and clipped repeat faces', () => {
  it('returns one ground region for an empty cell', () => {
    const result = buildPlanarMap(geometry([]), bounds);
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0]).toMatchObject({ id: 'ground', outer: null, holes: [], areaDu: 10000, seamGroup: 'ground' });
    validatePartition(result.faces);
  });

  it('distinguishes square interior from the ground and uses consistent boundary ties', () => {
    const result = buildPlanarMap(geometry([square(20, 20, 40)]), bounds);
    expect(result.faces).toHaveLength(2);
    expect(faceAt(result.faces, { x: 30, y: 30 })?.areaDu).toBe(1600);
    expect(faceAt(result.faces, { x: 5, y: 5 })?.id).toBe('ground');
    expect(faceAt(result.faces, { x: 20, y: 30 })?.id).not.toBe('ground');
    expect(faceAt(result.faces, { x: 60, y: 30 })?.id).toBe('ground');
    expect(result.vertices - result.segments + result.faces.length).toBe(result.components);
    validatePartition(result.faces);
  });

  it('assigns nested holes to their immediate enclosing face', () => {
    const result = buildPlanarMap(geometry([square(10, 10, 80), square(30, 30, 40), square(40, 40, 20)]), bounds);
    expect(result.faces).toHaveLength(4);
    expect(faceAt(result.faces, { x: 20, y: 20 })?.areaDu).toBe(4800);
    expect(faceAt(result.faces, { x: 35, y: 35 })?.areaDu).toBe(1200);
    expect(faceAt(result.faces, { x: 50, y: 50 })?.areaDu).toBe(400);
    validatePartition(result.faces);
  });

  it('merges collinear overlapping boundaries without duplicating faces', () => {
    const result = buildPlanarMap(geometry([square(10, 10, 30), square(40, 10, 30), [[20, 10], [60, 10]]]), bounds);
    expect(result.faces).toHaveLength(3);
    expect(faceAt(result.faces, { x: 20, y: 20 })?.id).not.toBe(faceAt(result.faces, { x: 50, y: 20 })?.id);
    validatePartition(result.faces);
  });

  it('splits crossings and T junctions while dangling strokes do not create faces', () => {
    const result = buildPlanarMap(geometry([square(10, 10, 80), [[10, 50], [90, 50]], [[50, 10], [50, 90]], [[25, 25], [30, 30]]]), bounds);
    expect(result.faces).toHaveLength(5);
    const quadrantIds = [[25, 25], [75, 25], [25, 75], [75, 75]].map(([x, y]) => faceAt(result.faces, { x, y })?.id);
    expect(new Set(quadrantIds).size).toBe(4);
    validatePartition(result.faces);
  });

  it('handles touching loops at a shared tangent vertex', () => {
    const result = buildPlanarMap(geometry([square(10, 10, 30), square(40, 40, 30)]), bounds);
    expect(result.faces).toHaveLength(3);
    validatePartition(result.faces);
  });

  it('clips and unifies the two pieces of a motif crossing a straight seam', () => {
    const result = buildPlanarMap(geometry([square(90, 30, 20)]), bounds);
    expect(result.faces).toHaveLength(3);
    const left = faceAt(result.faces, { x: 5, y: 40 })!, right = faceAt(result.faces, { x: 95, y: 40 })!;
    expect(left.id).not.toBe(right.id);
    expect(left.seamGroup).toBe(right.seamGroup);
    expect(left.seamGroup).not.toBe('ground');
    for (const face of result.faces) for (const p of face.outer ?? []) {
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(100);
    }
    validatePartition(result.faces);
  });

  it('keeps opposite border regions independent in a non-repeating panel', () => {
    const result = buildPlanarMap(geometry([square(-10, 30, 20), square(90, 30, 20)]), bounds, { type: 'none' });
    const left = faceAt(result.faces, { x: 5, y: 40 })!, right = faceAt(result.faces, { x: 95, y: 40 })!;
    expect(left.id).not.toBe(right.id); expect(left.seamGroup).not.toBe(right.seamGroup);
    const saved = resolveFaceColors(result.faces, { [left.id]: { colorIndex: 2, ref: left.ref }, [right.id]: { colorIndex: 5, ref: right.ref } });
    expect(saved.faceColors[left.id].colorIndex).toBe(2); expect(saved.faceColors[right.id].colorIndex).toBe(5);
    expect(result.warnings).toEqual([]);
    validatePartition(result.faces);
  });

  it('clips an outside motif without making a replica on the opposite panel border', () => {
    const result = buildPlanarMap(geometry([square(90, 30, 20)]), bounds, { type: 'none' });
    expect(result.faces).toHaveLength(2);
    expect(faceAt(result.faces, { x: 5, y: 40 })?.id).toBe('ground');
    expect(faceAt(result.faces, { x: 95, y: 40 })?.id).not.toBe('ground');
    validatePartition(result.faces);
  });

  it('does not unify across a real edge lying exactly on the seam', () => {
    const result = buildPlanarMap(geometry([square(0, 20, 30)]), bounds);
    const motif = faceAt(result.faces, { x: 10, y: 30 })!, across = faceAt(result.faces, { x: 99, y: 30 })!;
    expect(motif.seamGroup).not.toBe(across.seamGroup);
    validatePartition(result.faces);
  });

  it('wraps a motif translated more than one full cell', () => {
    const original = buildPlanarMap(geometry([square(10, 20, 20)]), bounds);
    const moved = buildPlanarMap(geometry([square(310, -180, 20)]), bounds);
    expect(moved.faces).toEqual(original.faces);
  });

  it('keeps IDs stable when geometry insertion order changes', () => {
    const source = geometry([square(10, 10, 30), square(50, 50, 20)]);
    const reversed = { ...source, edges: Object.fromEntries(Object.entries(source.edges).reverse()), nodes: Object.fromEntries(Object.entries(source.nodes).reverse()) };
    expect(buildPlanarMap(reversed, bounds)).toEqual(buildPlanarMap(source, bounds));
  });

  it('warns explicitly that non-straight editing is unsupported', () => {
    expect(buildPlanarMap(geometry([]), bounds, { type: 'half-drop' }).warnings.join(' ')).toContain('not implemented');
  });

  it('rejects unsafe coordinates before computing repeat translations', () => {
    expect(() => buildPlanarMap(geometry([[[1e20, 0], [1e20, 1]]]), bounds)).toThrow('fixed-point coordinate range');
  });

  it('flattens cubic curves without losing endpoints or small closed loops', () => {
    const source = geometry([[[10, 10], [90, 10]]]);
    source.edges.e0.segments = [{ c1: { x: 10, y: 90 }, c2: { x: 90, y: 90 } }];
    const flat = flattenEdge(source.edges.e0, source);
    expect(flat[0]).toEqual({ x: 10, y: 10 }); expect(flat.at(-1)).toEqual({ x: 90, y: 10 });
    expect(flat.length).toBeGreaterThan(10);
    expect(Math.max(...flat.map(p => p.y))).toBeCloseTo(70, 4);
  });

  it('partitions deterministic overlapping rectangles and quantized diagonal crossings', () => {
    const paths: number[][][] = [];
    for (let i = 0; i < 20; i++) paths.push(square(8 + (i * 17) % 60, 7 + (i * 23) % 60, 10 + i % 9));
    paths.push([[5, 5], [95, 83]], [[5, 95], [91, 5]]);
    const result = buildPlanarMap(geometry(paths), bounds);
    expect(result.warnings).toEqual([]);
    expect(result.vertices - result.segments + result.faces.length).toBe(result.components);
    validatePartition(result.faces);
  });

  it('handles thousands of disjoint strokes in one spatial bucket without a quadratic pair Set', () => {
    // 7,000 strokes formerly inserted more than 24 million pair keys into the
    // global Set, despite none of their bounding boxes intersecting.
    const paths: number[][][] = Array.from({ length: 7000 }, (_, i) => {
      const x = 1 + (i % 100) * 0.5, y = 1 + Math.floor(i / 100) * 0.5;
      return [[x, y], [x + 0.125, y]];
    });
    const result = buildPlanarMap(geometry(paths), bounds, { type: 'none' });
    expect(result.faces).toHaveLength(1);
    expect(result.components).toBe(7001);
    expect(result.vertices - result.segments + result.faces.length).toBe(result.components);
    expect(result.warnings).toEqual([]);
  });
});

describe('face identity and color tracking', () => {
  it('retains color and ID after an exact translation with no old overlap', () => {
    const previous = buildPlanarMap(geometry([square(10, 10, 15)]), bounds).faces;
    const next = buildPlanarMap(geometry([square(70, 70, 15)]), bounds).faces;
    const old = faceAt(previous, { x: 15, y: 15 })!;
    const tracked = trackFaces(previous, colorMap(previous, face => face.outer ? 3 : 0), next);
    const moved = faceAt(tracked.faces, { x: 75, y: 75 })!;
    expect(moved.id).toBe(old.id); expect(tracked.faceColors[moved.id].colorIndex).toBe(3);
    expect(tracked.warnings).toEqual([]);
  });

  it('preserves a tiny translated face even when the sampling grid misses it', () => {
    const big = { w: 4096, h: 4096 };
    const previous = buildPlanarMap(geometry([square(100, 100, 0.125)]), big).faces;
    const next = buildPlanarMap(geometry([square(200, 200, 0.125)]), big).faces;
    const tracked = trackFaces(previous, colorMap(previous, face => face.outer ? 2 : 0), next);
    expect(tracked.faceColors[faceAt(tracked.faces, { x: 200.0625, y: 200.0625 })!.id].colorIndex).toBe(2);
  });

  it('inherits the old face color in both children after a split', () => {
    const previous = buildPlanarMap(geometry([square(10, 10, 80)]), bounds).faces;
    const next = buildPlanarMap(geometry([square(10, 10, 80), [[50, 10], [50, 90]]]), bounds).faces;
    const tracked = trackFaces(previous, colorMap(previous, face => face.outer ? 4 : 0), next);
    const left = faceAt(tracked.faces, { x: 20, y: 30 })!, right = faceAt(tracked.faces, { x: 70, y: 30 })!;
    expect(tracked.faceColors[left.id].colorIndex).toBe(4); expect(tracked.faceColors[right.id].colorIndex).toBe(4);
    expect(new Set(tracked.faces.map(face => face.id)).size).toBe(tracked.faces.length);
  });

  it('keeps the larger prior color and reports a merge conflict', () => {
    const previous = buildPlanarMap(geometry([square(10, 10, 80), [[40, 10], [40, 90]]]), bounds).faces;
    const next = buildPlanarMap(geometry([square(10, 10, 80)]), bounds).faces;
    const tracked = trackFaces(previous, colorMap(previous, face => !face.outer ? 0 : face.ref.x < 40 ? 2 : 5), next);
    const merged = faceAt(tracked.faces, { x: 50, y: 50 })!;
    expect(tracked.faceColors[merged.id].colorIndex).toBe(5);
    expect(tracked.warnings.join(' ')).toContain('Merged colors 2, 5');
  });

  it('propagates a color across both clipped pieces of a seam face', () => {
    const next = buildPlanarMap(geometry([square(90, 30, 20)]), bounds).faces;
    const left = faceAt(next, { x: 5, y: 40 })!, right = faceAt(next, { x: 95, y: 40 })!;
    const colors = colorMap(next, face => face.id === left.id ? 6 : face.id === 'ground' ? 0 : null);
    const tracked = trackFaces(next, colors, next);
    expect(tracked.faceColors[right.id].colorIndex).toBe(6);
  });
});

describe('persisted face color materialization', () => {
  it('retains same-ID assignments and recolored ground without previous face geometry', () => {
    const faces = buildPlanarMap(geometry([square(10, 10, 30)]), bounds).faces;
    const persisted = colorMap(faces, face => face.outer ? 3 : 5);
    const tracked = trackFaces([], persisted, faces);
    expect(tracked.faceColors).toEqual(persisted);
    expect(tracked.warnings).toEqual([]);
  });

  it('restores translated colors after JSON serialization and deterministic topology rebuild', () => {
    const before = buildPlanarMap(geometry([square(10, 10, 15)]), bounds).faces;
    const afterGeometry = geometry([square(70, 70, 15)]);
    const tracked = trackFaces(before, colorMap(before, face => face.outer ? 4 : 7), buildPlanarMap(afterGeometry, bounds).faces);
    const persisted: Record<string, FaceColor> = JSON.parse(JSON.stringify(tracked.faceColors));
    const reloadedFaces = buildPlanarMap(afterGeometry, bounds).faces;
    const moved = faceAt(reloadedFaces, { x: 75, y: 75 })!;
    expect(persisted[moved.id]).toBeUndefined();
    const snapshot = JSON.stringify({ reloadedFaces, persisted });
    const resolved = resolveFaceColors(reloadedFaces, persisted);
    expect(resolved.faceColors[moved.id].colorIndex).toBe(4);
    expect(resolved.faceColors.ground.colorIndex).toBe(7);
    expect(resolved.faceColors[moved.id].ref).toEqual(moved.ref);
    expect(JSON.stringify({ reloadedFaces, persisted })).toBe(snapshot);
    expect(resolved.warnings).toEqual([]);
  });

  it('keeps a direct assignment over a conflicting stale reference, independent of record order', () => {
    const faces = buildPlanarMap(geometry([square(10, 10, 30)]), bounds).faces;
    const motif = faceAt(faces, { x: 20, y: 20 })!;
    const persisted = { stale: { colorIndex: 6, ref: motif.ref }, [motif.id]: { colorIndex: 2, ref: motif.ref } };
    const resolved = resolveFaceColors(faces, persisted);
    expect(resolved.faceColors[motif.id].colorIndex).toBe(2);
    expect(resolved.warnings.join(' ')).toContain('current ID assignment');
    expect(resolveFaceColors(faces, Object.fromEntries(Object.entries(persisted).reverse()))).toEqual(resolved);
  });

  it('preserves explicitly unassigned current IDs instead of resurrecting a stale color', () => {
    const faces = buildPlanarMap(geometry([square(10, 10, 30)]), bounds).faces;
    const motif = faceAt(faces, { x: 20, y: 20 })!;
    const resolved = resolveFaceColors(faces, { stale: { colorIndex: 6, ref: motif.ref }, [motif.id]: { colorIndex: null, ref: motif.ref } });
    expect(resolved.faceColors[motif.id].colorIndex).toBeNull();
    expect(resolved.warnings).toHaveLength(1);
  });

  it('supports a stale ground reference without default color 0 overriding it', () => {
    const faces = buildPlanarMap(geometry([square(10, 10, 30)]), bounds).faces;
    const resolved = resolveFaceColors(faces, { oldGround: { colorIndex: 6, ref: { x: 5, y: 5 } } });
    expect(resolved.faceColors.ground.colorIndex).toBe(6);
  });

  it('unifies saved seam colors and reports contradictory assignments', () => {
    const faces = buildPlanarMap(geometry([square(90, 30, 20)]), bounds).faces;
    const left = faceAt(faces, { x: 5, y: 40 })!, right = faceAt(faces, { x: 95, y: 40 })!;
    const partial = resolveFaceColors(faces, { [left.id]: { colorIndex: 6, ref: left.ref } });
    expect(partial.faceColors[right.id].colorIndex).toBe(6);
    const contradictory = resolveFaceColors(faces, { [left.id]: { colorIndex: 6, ref: left.ref }, [right.id]: { colorIndex: 2, ref: right.ref } });
    expect(contradictory.faceColors[left.id].colorIndex).toBe(contradictory.faceColors[right.id].colorIndex);
    expect(contradictory.warnings.join(' ')).toContain('Conflicting saved colors across repeat seam');
  });

  it('retains recolored ground across every clipped ground piece', () => {
    const faces = buildPlanarMap(geometry([[[0, 40], [100, 40]], [[0, 60], [100, 60]]]), bounds).faces;
    const groundPieces = faces.filter(face => face.seamGroup === 'ground');
    expect(groundPieces.length).toBeGreaterThan(1);
    const resolved = resolveFaceColors(faces, { ground: { colorIndex: 5, ref: faces.find(face => face.id === 'ground')!.ref } });
    for (const face of groundPieces) expect(resolved.faceColors[face.id].colorIndex).toBe(5);
  });
});
