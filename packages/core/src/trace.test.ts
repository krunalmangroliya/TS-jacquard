import { describe, expect, it } from 'vitest';
import { binarize, closeGaps, despeckle, estimateLineWidth, estimatePathStrokeWidths, extendSourceBorderEnds, extractSkeletonGraph, findPossibleTipSpurs, fitCubicPolyline, otsuThreshold, pruneSpurs, rasterLuminance, simplifyPolyline, skeletonize, traceImage } from './trace.js';
import { buildPlanarMap, faceAt } from './topology.js';
import type { SkeletonGraph } from './trace.js';
import type { RasterInput, Vec2 } from './types.js';

const raster = (w: number, h: number, foreground: (x: number, y: number) => boolean): RasterInput => ({
  width: w, height: h, channels: 1,
  data: Uint8Array.from({ length: w * h }, (_, i) => foreground(i % w, Math.floor(i / w)) ? 0 : 255),
});
const p = (x: number, y: number): Vec2 => ({ x, y });
const square = (x: number, y: number): boolean => (x === 5 || x === 25) && y >= 5 && y <= 25 || (y === 5 || y === 25) && x >= 5 && x <= 25;
const graph = (vertices: Vec2[], pairs: [number, number][]): SkeletonGraph => ({
  vertices, paths: pairs.map(([start, end]) => ({ start, end, points: [vertices[start], vertices[end]] })),
});

describe('trace threshold and cleanup', () => {
  it('composites transparent black over white and preserves opaque source luminance', () => {
    const input: RasterInput = { width: 3, height: 1, channels: 4, data: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 128]) };
    expect([...rasterLuminance(input)]).toEqual([255, 0, 127]);
    expect([...binarize(input, 100).binary]).toEqual([0, 1, 0]);
    expect([...input.data]).toEqual([0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 128]);
  });

  it('finds a deterministic Otsu split and handles a blank white image', () => {
    expect(otsuThreshold(new Uint8Array([0, 0, 220, 255]))).toBe(0);
    expect([...binarize(raster(8, 8, () => false)).binary]).toEqual(Array(64).fill(0));
    const inverted = raster(8, 8, (x, y) => x !== y);
    expect([...binarize(inverted, 'otsu', true).binary]).toEqual(Array.from({ length: 64 }, (_, i) => i % 8 === Math.floor(i / 8) ? 1 : 0));
  });

  it('removes a tiny isolated speck, fills a pinhole, and keeps external background', () => {
    const binary = binarize(raster(12, 12, (x, y) => x >= 3 && x <= 8 && y >= 3 && y <= 8 && !(x === 5 && y === 5) || x === 1 && y === 1)).binary;
    const cleaned = despeckle(binary, 12, 12, 4);
    expect(cleaned[13]).toBe(0);
    expect(cleaned[5 * 12 + 5]).toBe(1);
    expect(cleaned[0]).toBe(0);
    expect(binary[13]).toBe(1);
    expect(binary[5 * 12 + 5]).toBe(0);
  });

  it('estimates line width from skeleton distance without altering either raster', () => {
    const binary = binarize(raster(24, 24, (x, y) => x >= 5 && x <= 18 && y >= 9 && y <= 13)).binary;
    const original = binary.slice();
    const skeleton = skeletonize(binary, 24, 24);
    expect(estimateLineWidth(binary, skeleton, 24, 24)).toBeGreaterThanOrEqual(4);
    expect(estimateLineWidth(binary, skeleton, 24, 24)).toBeLessThanOrEqual(6);
    expect(binary).toEqual(original);
    expect([...skeleton].reduce((sum, v) => sum + v, 0)).toBeLessThan([...binary].reduce((sum, v) => sum + v, 0));
  });

  it('rejects malformed raster dimensions, channels, and thresholds', () => {
    expect(() => traceImage({ width: 3, height: 1, channels: 1, data: new Uint8Array(2) })).toThrow(/match/);
    expect(() => traceImage(raster(8, 8, square), { fitMaxError: 0 })).toThrow(/greater than zero/);
    expect(() => binarize(raster(8, 8, square), 256)).toThrow(/Threshold/);
  });
});

describe('skeleton graph', () => {
  it('extracts a closed loop once without inventing corner branches', () => {
    const binary = binarize(raster(32, 32, square)).binary;
    const skeleton = skeletonize(binary, 32, 32);
    const result = extractSkeletonGraph(skeleton, 32, 32);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0].start).toBe(result.paths[0].end);
    expect(result.paths[0].points.length).toBeGreaterThan(60);
  });

  it('keeps a T-junction as three branches sharing one node', () => {
    const binary = binarize(raster(32, 32, (x, y) => y === 8 && x >= 5 && x <= 25 || x === 15 && y >= 8 && y <= 25)).binary;
    const result = extractSkeletonGraph(skeletonize(binary, 32, 32), 32, 32);
    expect(result.paths).toHaveLength(3);
    const endpoints = result.paths.flatMap(path => [path.start, path.end]);
    expect(Math.max(...result.vertices.map((_, i) => endpoints.filter(id => id === i).length))).toBe(3);
  });

  it('clusters adjacent junction pixels of a plus into one intersection', () => {
    const result = traceImage(raster(32, 32, (x, y) => y === 15 && x >= 5 && x <= 25 || x === 15 && y >= 5 && y <= 25), { gapClosePx: 0 });
    expect(result.report.edges).toBe(4);
    expect(result.report.openEnds).toHaveLength(4);
    expect(result.objects).toHaveLength(1);
  });

  it('preserves an isolated short detail stroke while pruning a short junction spur', () => {
    const input = graph([p(0, 10), p(10, 10), p(20, 10), p(10, 8), p(30, 10), p(32, 10)], [[0, 1], [1, 2], [1, 3], [4, 5]]);
    const result = pruneSpurs(input, 3);
    expect(result.pruned).toBe(1);
    expect(result.graph.paths).toHaveLength(3);
    expect(result.graph.paths.some(path => path.start === 4 && path.end === 5)).toBe(true);
    expect(input.paths).toHaveLength(4);
  });

  it('labels likely acute-tip thinning spurs without changing them or mislabeling a T-junction', () => {
    const input = graph([p(0, 10), p(10, 10), p(30, 5), p(30, 15)], [[0, 1], [1, 2], [1, 3]]);
    const snapshot = JSON.stringify(input);
    expect(findPossibleTipSpurs(input, 4)).toEqual([{ endpoint: p(0, 10), junction: p(10, 10), length: 10 }]);
    expect(JSON.stringify(input)).toBe(snapshot);
    const tee = graph([p(0, 10), p(10, 10), p(20, 10), p(10, 8)], [[0, 1], [1, 2], [1, 3]]);
    expect(findPossibleTipSpurs(tee, 4)).toEqual([]);
    const isolated = graph([p(0, 0), p(2, 0)], [[0, 1]]);
    expect(findPossibleTipSpurs(isolated, 4)).toEqual([]);
  });
});

describe('tangent-aware gap repairs', () => {
  it('joins facing endpoints within the configured radius', () => {
    const input = graph([p(0, 0), p(10, 0), p(16, 0), p(25, 0)], [[0, 1], [2, 3]]);
    const result = closeGaps(input, 6);
    expect(result.closed).toEqual([{ from: p(10, 0), to: p(16, 0) }]);
    expect(result.graph.paths).toHaveLength(3);
    expect(input.paths).toHaveLength(2);
  });

  it('does not bridge nearby parallel strokes perpendicular to their tangents', () => {
    const result = closeGaps(graph([p(0, 0), p(10, 0), p(0, 3), p(10, 3)], [[0, 1], [2, 3]]), 4);
    expect(result.closed).toHaveLength(0);
  });

  it('splits a target segment when a terminal points into its interior', () => {
    const result = closeGaps(graph([p(0, 10), p(20, 10), p(10, 0), p(10, 7)], [[0, 1], [2, 3]]), 3);
    expect(result.closed).toEqual([{ from: p(10, 7), to: p(10, 10) }]);
    expect(result.graph.paths).toHaveLength(4);
    const intersection = result.graph.vertices.findIndex(v => v.x === 10 && v.y === 10);
    expect(result.graph.paths.filter(path => path.start === intersection || path.end === intersection)).toHaveLength(3);
  });

  it('closes a six-pixel break in a traced outline', () => {
    const input = raster(64, 64, (x, y) => ((x === 10 || x === 50) && y >= 10 && y <= 50 || (y === 10 || y === 50) && x >= 10 && x <= 50) && !(y === 10 && x >= 28 && x <= 32));
    const result = traceImage(input, { gapClosePx: 6 });
    expect(result.report.autoClosed).toHaveLength(1);
    expect(result.report.openEnds).toHaveLength(0);
    expect(result.report.objects).toBe(1);
  });

  it('repairs thousands of independent breaks without global pair rescans or cross-row joins', () => {
    const vertices: Vec2[] = [], pairs: [number, number][] = [];
    for (let row = 0; row < 1000; row++) {
      const base = vertices.length;
      vertices.push(p(0, row * 12), p(10, row * 12), p(13, row * 12), p(23, row * 12));
      pairs.push([base, base + 1], [base + 2, base + 3]);
    }
    const result = closeGaps(graph(vertices, pairs), 3);
    expect(result.closed).toHaveLength(1000);
    expect(result.graph.paths).toHaveLength(3000);
    result.closed.forEach((gap, row) => expect(gap).toEqual({ from: p(10, row * 12), to: p(13, row * 12) }));
  });

  it('updates nearby candidates when a newly inserted bridge becomes their valid target', () => {
    const input = graph([p(0, 5), p(10, 5), p(5, 0), p(5, 2), p(0, 3), p(2, 3)], [[0, 1], [2, 3], [4, 5]]);
    expect(closeGaps(input, 3).closed).toEqual([
      { from: p(5, 2), to: p(5, 5) },
      { from: p(2, 3), to: p(5, 3) },
    ]);
  });

  it('invalidates stale nearest candidates after their target path is split', () => {
    const input = graph([p(0, 10), p(30, 10), p(10, 0), p(10, 7), p(20, 0), p(20, 7)], [[0, 1], [2, 3], [4, 5]]);
    const result = closeGaps(input, 3);
    expect(result.closed).toEqual([{ from: p(10, 7), to: p(10, 10) }, { from: p(20, 7), to: p(20, 10) }]);
    expect(result.graph.paths).toHaveLength(7);
  });
});

describe('source-border endpoints and repeat seams', () => {
  it('extends pixel-center endpoints exactly to all four cell edges', () => {
    const result = traceImage(raster(64, 64, (x, y) => y === 20 || x === 30), { gapClosePx: 0 });
    expect(result.report.openEnds).toEqual([p(30.5, 0), p(0, 20.5), p(64, 20.5), p(30.5, 64)]);
    expect(result.report.warnings.join(' ')).toMatch(/4 source-border line ends extended/);
  });

  it('restores source-border reach after thinning retreats a thick clipped stroke', () => {
    const result = traceImage(raster(64, 64, (x, y) => Math.abs(y - 20) <= 1 || Math.abs(x - 30) <= 1), { gapClosePx: 0 });
    expect(result.report.openEnds).toEqual([p(30.5, 0), p(0, 20.5), p(64, 20.5), p(30.5, 64)]);
  });

  it('keeps a near-border terminal unchanged if any original background separates it from the border', () => {
    const input = raster(64, 64, (x, y) => y === 20 && (x === 0 || x >= 2 && x <= 20));
    const result = traceImage(input, { gapClosePx: 0, minSpeckArea: 0 });
    expect(result.report.openEnds).toEqual([p(2.5, 20.5), p(20.5, 20.5)]);
    expect(result.report.warnings.join(' ')).not.toMatch(/source-border line ends extended/);
  });

  it('checks every crossed source pixel and never mutates the input graph', () => {
    const input = graph([p(1.5, 20.5), p(12.5, 20.5)], [[0, 1]]);
    const source = binarize(raster(32, 32, (x, y) => y === 20 && x <= 12)).binary;
    const snapshot = JSON.stringify(input);
    const extended = extendSourceBorderEnds(input, source, 32, 32, 4);
    expect(extended.extended).toEqual([{ from: p(1.5, 20.5), to: p(0, 20.5) }]);
    expect(JSON.stringify(input)).toBe(snapshot);
    source[20 * 32] = 0;
    expect(extendSourceBorderEnds(input, source, 32, 32, 4).extended).toEqual([]);
  });

  it('traces both halves of a valid thick seam motif into two bounded pieces with one seam identity', () => {
    const input = raster(64, 64, (x, y) =>
      (x <= 12 || x >= 51) && (Math.abs(y - 12) <= 1 || Math.abs(y - 44) <= 1)
      || (Math.abs(x - 12) <= 1 || Math.abs(x - 51) <= 1) && y >= 12 && y <= 44);
    const traced = traceImage(input, { gapClosePx: 0 });
    expect(traced.report.openEnds).toHaveLength(4);
    expect(traced.report.openEnds.every(v => v.x === 0 || v.x === 64)).toBe(true);
    const topology = buildPlanarMap(traced.geometry, { w: 64, h: 64 }, { type: 'straight' });
    const left = faceAt(topology.faces, p(5, 25));
    const right = faceAt(topology.faces, p(59, 25));
    expect(topology.faces.filter(face => face.outer !== null)).toHaveLength(2);
    expect(left?.seamGroup).toBe(right?.seamGroup);
    expect(left?.seamGroup).not.toBe('ground');
    expect(left?.id).not.toBe(right?.id);
  });
});

describe('visible source-proportional trace strokes', () => {
  it('measures thin, thick and even-width source strokes separately rather than using one global width', () => {
    const input = raster(96, 88, (x, y) => x >= 8 && x <= 87 && (y === 16 || y >= 38 && y <= 42 || y >= 65 && y <= 68));
    const traced = traceImage(input, { gapClosePx: 0 });
    const edges = Object.values(traced.geometry.edges).sort((a, b) => traced.geometry.nodes[a.nodeIds[0]].p.y - traced.geometry.nodes[b.nodeIds[0]].p.y);
    expect(edges).toHaveLength(3);
    expect(edges.map(edge => edge.width)).toEqual([1, 5, 4]);
    for (const edge of edges) expect(edge).toMatchObject({ widthMode: 'design', colorIndex: 5, strokeHidden: false, z: 0 });
    expect(traced.report.warnings.join(' ')).toMatch(/separate median source-ink cross-section/);
    expect(traced.report.warnings.join(' ')).toMatch(/original taper is approximated/);
  });

  it('does not let an inflated junction set the median width of neighboring branches', () => {
    const input = raster(96, 80, (x, y) => x >= 8 && x <= 87 && y >= 38 && y <= 40 || x >= 43 && x <= 51 && y >= 8 && y <= 71);
    const traced = traceImage(input, { gapClosePx: 0 });
    const widths = Object.values(traced.geometry.edges).map(edge => edge.width).sort((a, b) => a - b);
    expect(widths).toEqual([3, 3, 9, 9]);
    expect(traced.report.openEnds).toHaveLength(4);
  });

  it('bounds a tiny junction path whose estimated normal follows a very long neighboring stroke', () => {
    const input = graph([p(500.5, 14.5), p(500.5, 16.5)], [[0, 1]]);
    const source = binarize(raster(1024, 32, (_, y) => y >= 14 && y <= 16)).binary;
    const measured = estimatePathStrokeWidths(input, source, 1024, 32, 4);
    // The local source is three pixels thick; following the horizontal ink to the image edges
    // must not turn this two-pixel junction fragment into a 1024-pixel-wide visible stroke.
    expect(measured.widths[0]).toBeGreaterThanOrEqual(2.5);
    expect(measured.widths[0]).toBeLessThanOrEqual(4);
    expect(measured.inherited).toBe(0);
  });

  it('inherits the adjacent source width for a repaired segment lying in a white gap', () => {
    const input = graph([p(4.5, 15.5), p(14.5, 15.5), p(20.5, 15.5), p(30.5, 15.5)], [[0, 1], [2, 3], [1, 2]]);
    const source = binarize(raster(36, 32, (x, y) => y >= 14 && y <= 16 && (x >= 4 && x <= 14 || x >= 20 && x <= 30))).binary;
    const widths = estimatePathStrokeWidths(input, source, 36, 32, 4);
    expect(widths).toEqual({ widths: [3, 3, 3], inherited: 1 });
  });

  it('keeps source-width estimates deterministic under a ninety-degree stroke rotation', () => {
    const horizontal = traceImage(raster(96, 96, (x, y) => x >= 10 && x <= 85 && y >= 42 && y <= 48), { gapClosePx: 0 });
    const vertical = traceImage(raster(96, 96, (x, y) => y >= 10 && y <= 85 && x >= 42 && x <= 48), { gapClosePx: 0 });
    expect(Object.values(horizontal.geometry.edges).map(edge => edge.width)).toEqual([7]);
    expect(Object.values(vertical.geometry.edges).map(edge => edge.width)).toEqual([7]);
    expect(Object.values(horizontal.geometry.edges)[0].width * 64).toBe(448);
  });
});

describe('curve fit and complete trace', () => {
  it('simplifies a straight sampled line without discarding an intentional corner', () => {
    expect(simplifyPolyline([p(0, 0), p(2, 0), p(4, 0), p(4, 3), p(4, 6)], 0.1)).toEqual([0, 2, 4]);
  });

  it('fits a semicircle with compact cubic curves and source fidelity', () => {
    const points = Array.from({ length: 81 }, (_, i) => p(50 + 35 * Math.cos(i * Math.PI / 80), 50 + 35 * Math.sin(i * Math.PI / 80)));
    const curves = fitCubicPolyline(points, 0.3);
    expect(curves.length).toBeLessThanOrEqual(4);
    expect(curves.length).toBeGreaterThanOrEqual(1);
    const evaluated = curves.flatMap(c => Array.from({ length: 501 }, (_, i) => {
      const t = i / 500, u = 1 - t;
      return p(c.start.x * u ** 3 + 3 * c.c1.x * u * u * t + 3 * c.c2.x * u * t * t + c.end.x * t ** 3,
        c.start.y * u ** 3 + 3 * c.c1.y * u * u * t + 3 * c.c2.y * u * t * t + c.end.y * t ** 3);
    }));
    for (const source of points) expect(Math.min(...evaluated.map(v => Math.hypot(v.x - source.x, v.y - source.y)))).toBeLessThan(0.4);
    for (const v of evaluated) expect(Math.abs(Math.hypot(v.x - 50, v.y - 50) - 35)).toBeLessThan(0.5);
  });

  it('produces a single centerline loop for a thick circular ring and uses cubic handles', () => {
    const result = traceImage(raster(128, 128, (x, y) => Math.abs(Math.hypot(x - 64, y - 64) - 40) <= 2), { gapClosePx: 0 });
    expect(result.report.openEnds).toHaveLength(0);
    expect(result.objects).toHaveLength(1);
    expect(result.report.edges).toBe(1);
    expect(result.report.nodes).toBeLessThanOrEqual(16);
    const edge = Object.values(result.geometry.edges)[0];
    expect(edge.nodeIds[0]).toBe(edge.nodeIds[edge.nodeIds.length - 1]);
    expect(edge.segments.every(s => !!s.c1 && !!s.c2)).toBe(true);
    for (const n of Object.values(result.geometry.nodes)) expect(Math.abs(Math.hypot(n.p.x - 64.5, n.p.y - 64.5) - 40)).toBeLessThan(2);
  });

  it('preserves square corners, creates reading-order objects, and snaps every coordinate', () => {
    const result = traceImage(raster(80, 50, (x, y) => square(x, y) || square(x - 40, y - 15)));
    expect(result.objects).toHaveLength(2);
    expect(result.report.openEnds).toHaveLength(0);
    expect(result.report.nodes).toBe(8);
    const firstNode = result.geometry.nodes[result.geometry.edges[result.objects[0].edgeIds[0]].nodeIds[0]];
    expect(firstNode.p.x).toBeLessThan(40);
    for (const n of Object.values(result.geometry.nodes)) { expect(n.p.x * 64).toBe(Math.round(n.p.x * 64)); expect(n.p.y * 64).toBe(Math.round(n.p.y * 64)); }
    for (const edge of Object.values(result.geometry.edges)) {
      expect(edge.width).toBeGreaterThan(0);
      expect(edge.widthMode).toBe('design');
      expect(edge.colorIndex).toBe(5);
      expect(edge.strokeHidden).toBe(false);
      expect(edge.segments).toHaveLength(edge.nodeIds.length - 1);
      for (const handle of edge.segments.flatMap(s => [s.c1, s.c2]).filter(v => v !== undefined)) {
        expect(handle.x * 64).toBe(Math.round(handle.x * 64)); expect(handle.y * 64).toBe(Math.round(handle.y * 64));
      }
    }
  });

  it('returns byte-identical serialized output on repeated calls and keeps the source untouched', () => {
    const input = raster(96, 96, (x, y) => Math.abs(Math.hypot(x - 48, y - 48) - 30) < 2 || x === 48 && y >= 20 && y <= 76);
    const original = input.data.slice();
    expect(JSON.stringify(traceImage(input))).toBe(JSON.stringify(traceImage(input)));
    expect(input.data).toEqual(original);
  });

  it('reports conservative master defaults and keeps a small detail component in a large image', () => {
    const input = raster(512, 512, (x, y) => (x === 100 || x === 110) && y >= 100 && y <= 110 || (y === 100 || y === 110) && x >= 100 && x <= 110);
    const result = traceImage(input);
    expect(result.params.minSpeckArea).toBe(16);
    expect(result.params.spurPrunePx).toBe(0);
    expect(result.report.warnings.join(' ')).toMatch(/capped at 16/);
    expect(result.report.edges).toBe(1);
  });
});
