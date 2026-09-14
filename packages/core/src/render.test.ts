import { describe, expect, it } from 'vitest';
import { render } from './render';
import { buildPlanarMap } from './topology';
import { DEFAULT_PALETTE } from './types';
import type { Face, Geometry, RuleConfig, Vec2 } from './types';

const off: RuleConfig = { connectVisibleEdges4: false, minThicknessPx: 0, minRegionPx: 0, removeCheckerboard: false };
const empty = (): Geometry => ({ nodes: {}, edges: {}, faceColors: {} });
const rectangle = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
function face(id: string, outer: Vec2[] | null, areaDu = 1, holes: Vec2[][] = []): Face {
  return { id, outer, areaDu, holes, ref: outer?.[0] ?? { x: 0, y: 0 } };
}
function assign(geometry: Geometry, region: Face, color: number): Face { geometry.faceColors[region.id] = { colorIndex: color, ref: region.ref }; return region; }

describe('fixed-point face rendering', () => {
  it.each([3, 6, 12])('follows the pixel-center/top-left convention on a triangle at %i px', size => {
    const geometry = empty(), triangle = assign(geometry, face('triangle', [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 0, y: 12 }], 72), 1);
    const { grid } = render(geometry, [triangle], { w: 12, h: 12 }, DEFAULT_PALETTE, size, size, off);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) expect(grid[y * size + x]).toBe(x + y + 1 < size ? 1 : 0);
  });

  it('assigns pixel centers on shared vertical and horizontal boundaries to the right and below', () => {
    const geometry = empty(), left = assign(geometry, face('left', rectangle(0, 0, 3.5, 8), 28), 1), right = assign(geometry, face('right', rectangle(3.5, 0, 8, 8), 36), 2);
    const a = render(geometry, [left, right], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    const b = render(geometry, [right, left], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    expect(a.grid).toEqual(b.grid); expect([...a.grid.slice(0, 8)]).toEqual([1, 1, 1, 2, 2, 2, 2, 2]);
    const top = assign(geometry, face('top', rectangle(0, 0, 8, 3.5), 28), 1), bottom = assign(geometry, face('bottom', rectangle(0, 3.5, 8, 8), 36), 2);
    const horizontal = render(geometry, [top, bottom], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    expect(horizontal.grid[2 * 8]).toBe(1); expect(horizontal.grid[3 * 8]).toBe(2);
  });

  it('subtracts holes regardless of ring orientation and preserves the ground underneath', () => {
    const geometry = empty(), ground = assign(geometry, face('ground', null, 64), 2);
    for (const hole of [rectangle(2, 2, 6, 6), rectangle(2, 2, 6, 6).reverse()]) {
      const ring = assign(geometry, face('ring', rectangle(0, 0, 8, 8), 48, [hole]), 1);
      const result = render(geometry, [ring, ground], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
      expect(result.grid[0]).toBe(1); expect(result.grid[3 * 8 + 3]).toBe(2);
      expect(result.grid.filter(color => color === 2).length).toBe(16);
    }
  });

  it('propagates seam-group colors and reports other unassigned bounded faces', () => {
    const geometry = empty(), a = assign(geometry, face('a', rectangle(0, 0, 2, 8), 16), 3), b = face('b', rectangle(6, 0, 8, 8), 16), c = face('c', rectangle(2, 0, 6, 8), 32);
    a.seamGroup = b.seamGroup = 'wrap';
    const result = render(geometry, [a, b, c], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    expect(result.grid[0]).toBe(3); expect(result.grid[7]).toBe(3); expect(result.grid[4]).toBe(0);
    expect(result.report.unassignedFaces).toBe(1); expect(result.report.colorsUsed).toEqual([0, 3]);
  });

  it('warns when a colored subpixel face has no output sample', () => {
    const geometry = empty(), dot = assign(geometry, face('dot', rectangle(2, 2, 2.1, 2.1), 0.01), 1);
    const result = render(geometry, [dot], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    expect(result.report.smallFacesRemoved).toEqual([dot.ref]);
    expect(result.report.warnings.some(warning => warning.includes('details omitted'))).toBe(true);
  });

  it('reports lost portions of a wrapped logical face once', () => {
    const geometry = empty(), a = assign(geometry, face('a', rectangle(0, 2, 0.2, 2.1), 0.02), 1), b = face('b', rectangle(7.8, 2, 8, 2.1), 0.02);
    a.seamGroup = b.seamGroup = 'same-dot';
    const result = render(geometry, [a, b], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    expect(result.report.smallFacesRemoved).toEqual([a.ref]);
  });

  it('deduplicates several removed raster fragments belonging to one face', () => {
    const geometry = empty();
    // Two dots joined in vector space by a subpixel strip that misses every center.
    const fragmented = assign(geometry, face('fragmented', [{ x: 1, y: 1 }, { x: 6, y: 1 }, { x: 6, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 1.2 }, { x: 2, y: 1.2 }, { x: 2, y: 2 }, { x: 1, y: 2 }], 2.6), 1);
    const result = render(geometry, [fragmented], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, { ...off, minRegionPx: 4 });
    expect(result.report.changedPixelsByRule.minRegion).toBeGreaterThan(1);
    expect(result.report.smallFacesRemoved).toHaveLength(1);
  });

  it('applies overrides last and excludes their positions from cleanup masks', () => {
    const geometry = empty(), dot = assign(geometry, face('dot', rectangle(3, 3, 4, 4)), 1);
    const result = render(geometry, [dot], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, { ...off, minRegionPx: 4 }, [
      { x: 3, y: 3, colorIndex: 2 }, { x: 3, y: 3, colorIndex: 3 }, { x: -1, y: 0, colorIndex: 7 },
    ]);
    expect(result.grid[27]).toBe(3); expect(result.report.changedPixelsMask[27]).toBe(0); expect(result.report.changedPixelsByRule.minRegion).toBe(0);
    expect(result.report.colorsUsed).toEqual([0, 3]);
  });
});

describe('visible outline rasterization', () => {
  const line = (width: number, y = 4): Geometry => ({
    nodes: { a: { id: 'a', p: { x: 1, y }, kind: 'corner' }, b: { id: 'b', p: { x: 7, y }, kind: 'corner' } },
    edges: { outline: { id: 'outline', nodeIds: ['a', 'b'], segments: [{}], colorIndex: 1, width, z: 0 } }, faceColors: {},
  });

  it.each([8, 16, 32])('keeps a two-pixel outline exactly two rows thick at %i px', size => {
    const result = render(line(2), [], { w: 8, h: 8 }, DEFAULT_PALETTE, size, size, off);
    let count = 0; for (let y = 0; y < size; y++) count += result.grid[y * size + size / 2] === 1 ? 1 : 0;
    expect(count).toBe(2);
  });

  it('uses a half-open boundary tie for a one-pixel horizontal stroke', () => {
    const result = render(line(1), [], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    expect(result.grid[3 * 8 + 4]).toBe(1); expect(result.grid[4 * 8 + 4]).toBe(0);
  });

  it('wraps visible strokes at repeat boundaries', () => {
    const result = render(line(2, 0), [], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    expect(result.grid[4]).toBe(1); expect(result.grid[7 * 8 + 4]).toBe(1);
  });

  it('preserves intentional visible pixels through every rule', () => {
    const geometry = line(1), base = render(geometry, [], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    const clean = render(geometry, [], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, { ...off, minRegionPx: 100, minThicknessPx: 2, removeCheckerboard: true });
    base.grid.forEach((color, p) => { if (color === 1) expect(clean.grid[p]).toBe(1); });
  });

  it.each([8, 16, 32])('scales a two-design-unit stroke proportionally at %i px', size => {
    const geometry = line(2); geometry.edges.outline.widthMode = 'design';
    const result = render(geometry, [], { w: 8, h: 8 }, DEFAULT_PALETTE, size, size, off);
    let count = 0; for (let y = 0; y < size; y++) if (result.grid[y * size + size / 2] === 1) count++;
    expect(count).toBe(size / 4);
    expect(result.report.warnings).toEqual([]);
  });

  it('preserves equal physical thickness on a 60 EPI / 48 PPI non-square grid', () => {
    const geometry = line(5, 10); geometry.edges.outline.widthMode = 'design';
    geometry.nodes.a.p = { x: 4, y: 10 }; geometry.nodes.b.p = { x: 16, y: 10 };
    const horizontal = render(geometry, [], { w: 20, h: 20 }, DEFAULT_PALETTE, 60, 48, off, [], { type: 'none' });
    let pickThickness = 0; for (let y = 0; y < 48; y++) if (horizontal.grid[y * 60 + 30] === 1) pickThickness++;
    geometry.nodes.a.p = { x: 10, y: 4 }; geometry.nodes.b.p = { x: 10, y: 16 };
    const vertical = render(geometry, [], { w: 20, h: 20 }, DEFAULT_PALETTE, 60, 48, off, [], { type: 'none' });
    const hookThickness = vertical.grid.slice(24 * 60, 25 * 60).filter(color => color === 1).length;
    expect(hookThickness).toBe(15); expect(pickThickness).toBe(12);
    expect(hookThickness / 60).toBe(pickThickness / 48);
  });

  it('uses elliptical source-scaled round caps instead of a circular output footprint', () => {
    const geometry = line(4, 10); geometry.edges.outline.widthMode = 'design';
    geometry.nodes.a.p = geometry.nodes.b.p = { x: 10, y: 10 };
    const result = render(geometry, [], { w: 20, h: 20 }, DEFAULT_PALETTE, 40, 20, off, [], { type: 'none' });
    expect(result.grid[10 * 40 + 23]).toBe(1);
    expect(result.grid[12 * 40 + 20]).toBe(0);
    // Every center is independently checked against the source-space circle.
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) {
      const dx = (x + 0.5) / 2 - 10, dy = y + 0.5 - 10;
      expect(result.grid[y * 40 + x]).toBe(dx * dx + dy * dy < 4 ? 1 : 0);
    }
  });

  it('hides only the stroke while retaining topology and separately colored adjacent faces', () => {
    const geometry = line(2); geometry.edges.outline.widthMode = 'design'; geometry.edges.outline.colorIndex = 3;
    geometry.nodes.a.p = { x: 4, y: 0 }; geometry.nodes.b.p = { x: 4, y: 8 };
    const left = assign(geometry, face('left', rectangle(0, 0, 4, 8), 32), 1), right = assign(geometry, face('right', rectangle(4, 0, 8, 8), 32), 2);
    const before = buildPlanarMap(geometry, { w: 8, h: 8 }, { type: 'none' });
    const visible = render(geometry, [left, right], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    expect(visible.grid[3]).toBe(3); expect(visible.grid[4]).toBe(3);
    geometry.edges.outline.strokeHidden = true;
    expect(buildPlanarMap(geometry, { w: 8, h: 8 }, { type: 'none' })).toEqual(before);
    const hidden = render(geometry, [left, right], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    expect([...hidden.grid.slice(0, 8)]).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(geometry.edges.outline.width).toBe(2);
  });

  it('allows genuinely subpixel source widths to miss the grid and reports their count', () => {
    const geometry = line(0.1); geometry.edges.outline.widthMode = 'design';
    const result = render(geometry, [], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    expect(result.grid.every(color => color === 0)).toBe(true);
    expect(result.report.warnings).toEqual(['1 source-scaled stroke(s) are thinner than one output pixel along at least one grid axis; some details may not sample at this size.']);
    geometry.nodes.a.p.y = geometry.nodes.b.p.y = 4.5;
    const centered = render(geometry, [], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off);
    expect(centered.grid[4 * 8 + 4]).toBe(1);
    geometry.edges.outline.strokeHidden = true;
    expect(render(geometry, [], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off).report.warnings).toEqual([]);
  });

  it('rejects invalid widths before silent filtering and retains explicit legacy output behavior', () => {
    for (const width of [-1, NaN, Infinity]) expect(() => render(line(width), [], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off)).toThrow('finite nonnegative');
    const legacy = line(0.1), explicit = line(0.1); explicit.edges.outline.widthMode = 'output';
    expect(render(legacy, [], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off)).toEqual(render(explicit, [], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off));
    const invalid = line(1); (invalid.edges.outline as unknown as { widthMode: string }).widthMode = 'physical';
    expect(() => render(invalid, [], { w: 8, h: 8 }, DEFAULT_PALETTE, 8, 8, off)).toThrow('unsupported width mode');
  });
});
