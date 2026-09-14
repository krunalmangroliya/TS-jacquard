import { describe, expect, it } from 'vitest';
import { traceGoldArtwork, goldFaceColors } from './gold-contours';
import { importPalette } from './input-preprocessing';
import { buildPlanarMap } from './topology';
import { render } from './render';
import { DEFAULT_PALETTE, type RasterInput } from './types';

const colors = importPalette(DEFAULT_PALETTE, 'black-gold'), repeat = { type: 'none' as const };
const rules = { minRegionPx: 0, minThicknessPx: 0, removeCheckerboard: false, connectVisibleEdges4: false };
function raster(width: number, height: number, ink: (x: number, y: number) => boolean): RasterInput {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(ink(x, y) ? [216,184,92] : [18,18,16], (y * width + x) * 3);
  return { width, height, channels: 3, data };
}
function restored(input: RasterInput, tolerance = 0) {
  const result = traceGoldArtwork(input, { minSpeckArea: 0, simplifyTolerance: tolerance }), bounds = { w: input.width, h: input.height };
  const topology = buildPlanarMap(result.trace.geometry, bounds, repeat);
  result.trace.geometry.faceColors = goldFaceColors(topology.faces, result.binary, input.width, input.height, colors.strokeColorIndex);
  const grid = render(result.trace.geometry, topology.faces, bounds, colors.palette, input.width, input.height, rules, [], repeat).grid;
  return { ...result, topology, bounds, grid };
}

describe('filled gold contour tracing', () => {
  it('preserves broad petals, narrow engraving, enclosed holes and border cuts exactly at zero tolerance', () => {
    const input = raster(64, 64, (x, y) => ((x - 24) ** 2 / 500 + (y - 30) ** 2 / 650 < 1 && !(x >= 21 && x <= 22 && y > 15 && y < 43)) || (x > 44 && y % 7 === 2) || (x < 4 && y > 8 && y < 53));
    const { grid, binary, trace } = restored(input);
    expect(grid).toEqual(binary.map(pixel => pixel ? colors.strokeColorIndex : 0));
    expect(Object.values(trace.geometry.edges).every(edge => edge.nodeIds[0] === edge.nodeIds.at(-1) && edge.width === 0 && edge.widthMode === 'design' && edge.strokeHidden === false)).toBe(true);
    expect(trace.report.openEnds).toEqual([]);
  });

  it('keeps nested gold islands and diagonally touching tiny shapes separate', () => {
    const input = raster(40, 40, (x, y) => (x >= 3 && x < 35 && y >= 3 && y < 35 && !(x >= 7 && x < 31 && y >= 7 && y < 31)) || (x >= 13 && x < 24 && y >= 13 && y < 24) || (x === 0 && y === 0) || (x === 1 && y === 1));
    const { grid, binary } = restored(input);
    expect(grid).toEqual(binary.map(pixel => pixel ? colors.strokeColorIndex : 0));
  });

  it('round-trips a deterministic mask with many corner contacts and cavities', () => {
    let state = 123456;
    const input = raster(40, 40, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % 5 < 2; });
    const { grid, binary } = restored(input);
    expect(grid).toEqual(binary.map(pixel => pixel ? colors.strokeColorIndex : 0));
    expect(traceGoldArtwork(input, { minSpeckArea: 0, simplifyTolerance: 0 }).trace.geometry).toEqual(traceGoldArtwork(input, { minSpeckArea: 0, simplifyTolerance: 0 }).trace.geometry);
  });

  it('handles entirely dark or entirely gold images without inventing regions', () => {
    for (const full of [false, true]) {
      const { grid, trace } = restored(raster(16, 16, () => full));
      expect([...grid].every(index => index === (full ? colors.strokeColorIndex : 0))).toBe(true);
      expect(trace.report.edges).toBe(full ? 1 : 0);
    }
  });

  it('caps contour simplification at one pixel and keeps fills when outlines are hidden', () => {
    const input = raster(32, 32, (x, y) => x > 4 && x < 27 && y > 4 && y < 27);
    const limited = traceGoldArtwork(input, { simplifyTolerance: 99, minSpeckArea: 99, gapClosePx: 20, spurPrunePx: 10 });
    expect(limited.trace.params.simplifyTolerance).toBe(1); expect(limited.trace.params.minSpeckArea).toBe(4); expect(limited.trace.params.gapClosePx).toBe(0); expect(limited.trace.params.spurPrunePx).toBe(0);
    const { trace, grid, topology, bounds } = restored(input);
    for (const edge of Object.values(trace.geometry.edges)) edge.strokeHidden = true;
    expect(render(trace.geometry, topology.faces, bounds, colors.palette, input.width, input.height, rules, [], repeat).grid).toEqual(grid);
  });
});
