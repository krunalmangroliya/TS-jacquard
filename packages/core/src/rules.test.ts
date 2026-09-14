import { describe, expect, it } from 'vitest';
import { applyRules, RULE_BITS } from './rules';
import { DEFAULT_PALETTE } from './types';
import type { RuleConfig } from './types';

const off: RuleConfig = { connectVisibleEdges4: false, minThicknessPx: 0, minRegionPx: 0, removeCheckerboard: false };
const clipped = { type: 'half-drop' } as const;

describe('deterministic indexed cleanup', () => {
  it('removes a minor dot, while a protected color survives', () => {
    const grid = new Uint8Array(64); grid[27] = 1; grid[36] = 2;
    const result = applyRules(grid, 8, 8, DEFAULT_PALETTE, { ...off, minRegionPx: 4, protectedColorIndices: [2] });
    expect(result.grid[27]).toBe(0); expect(result.grid[36]).toBe(2);
    expect(result.changedPixelsByRule.minRegion).toBe(1);
    expect(result.changedPixelsMask[27]).toBe(RULE_BITS.minRegion);
    expect(result.smallRegionsRemoved).toEqual([{ x: 3.5, y: 3.5 }]);
    expect(grid[27]).toBe(1);
  });

  it('counts 4-connected components periodically across all four corners', () => {
    const grid = new Uint8Array(64); for (const p of [0, 7, 56, 63]) grid[p] = 1;
    const cfg = { ...off, minRegionPx: 4 };
    expect(applyRules(grid, 8, 8, DEFAULT_PALETTE, cfg).grid).toEqual(grid);
    const bounded = applyRules(grid, 8, 8, DEFAULT_PALETTE, cfg, undefined, clipped);
    expect(bounded.grid.every(color => color === 0)).toBe(true);
    expect(bounded.warnings[0]).toContain('not implemented');
  });

  it('keeps opposite panel corners disconnected without an unsupported-repeat warning', () => {
    const grid = new Uint8Array(64); for (const p of [0, 7, 56, 63]) grid[p] = 1;
    const result = applyRules(grid, 8, 8, DEFAULT_PALETTE, { ...off, minRegionPx: 4 }, undefined, { type: 'none' });
    expect(result.grid.every(color => color === 0)).toBe(true);
    expect(result.changedPixelsByRule.minRegion).toBe(4);
    expect(result.warnings).toEqual([]);
  });

  it('preserves a substantial diagonal motif through minRegion and subsequent checkerboard cleanup', () => {
    const grid = new Uint8Array(64); for (const p of [18, 27, 36, 45]) grid[p] = 1;
    for (const removeCheckerboard of [false, true]) {
      const result = applyRules(grid, 8, 8, DEFAULT_PALETTE, { ...off, minRegionPx: 4, removeCheckerboard });
      expect(result.grid).toEqual(grid);
      expect(result.changedPixelsByRule.minRegion).toBe(0);
      expect(result.smallRegionsRemoved).toHaveLength(0);
      expect(result.warnings.some(warning => warning.includes('larger diagonal regions'))).toBe(true);
    }
  });

  it('recognizes diagonal aggregates across periodic seams', () => {
    const grid = new Uint8Array(64); for (const p of [7, 8, 17, 26]) grid[p] = 1;
    const cfg = { ...off, minRegionPx: 4, removeCheckerboard: true };
    expect(applyRules(grid, 8, 8, DEFAULT_PALETTE, cfg).grid).toEqual(grid);
    expect(applyRules(grid, 8, 8, DEFAULT_PALETTE, { ...cfg, removeCheckerboard: false }, undefined, clipped).grid.every(color => color === 0)).toBe(true);
  });

  it('bridges visible diagonals and keeps the new bridge through later cleanup', () => {
    const grid = new Uint8Array(64), visible = new Uint8Array(64);
    for (const p of [27, 36]) { grid[p] = 1; visible[p] = 1; }
    const result = applyRules(grid, 8, 8, DEFAULT_PALETTE, { ...off, connectVisibleEdges4: true, minRegionPx: 4, minThicknessPx: 2, removeCheckerboard: true }, visible);
    expect(result.grid[27]).toBe(1); expect(result.grid[36]).toBe(1); expect(result.grid[28]).toBe(1);
    expect(result.changedPixelsByRule.connectVisibleEdges4).toBe(1);
    expect(result.changedPixelsMask[28]).toBe(RULE_BITS.connectVisibleEdges4);
    expect(visible[28]).toBe(0);
  });

  it('bridges the other diagonal and diagonals across a repeat seam', () => {
    for (const points of [[28, 35], [31, 32], [7, 56]]) {
      const grid = new Uint8Array(64), visible = new Uint8Array(64);
      for (const p of points) { grid[p] = 1; visible[p] = 1; }
      const result = applyRules(grid, 8, 8, DEFAULT_PALETTE, { ...off, connectVisibleEdges4: true }, visible);
      expect(result.changedPixelsByRule.connectVisibleEdges4).toBe(1);
      expect(result.grid.reduce((sum, color) => sum + color, 0)).toBe(3);
    }
  });

  it('does not connect ordinary colored diagonals without a visible-edge mask', () => {
    const grid = new Uint8Array(64); grid[27] = grid[36] = 1;
    expect(applyRules(grid, 8, 8, DEFAULT_PALETTE, { ...off, connectVisibleEdges4: true }).grid).toEqual(grid);
  });

  it('uses opening only when enabled and preserves deliberate outlines and protected colors', () => {
    const grid = new Uint8Array(64), visible = new Uint8Array(64);
    grid[18] = 1; grid[21] = 2; grid[42] = 3; visible[42] = 1;
    const result = applyRules(grid, 8, 8, DEFAULT_PALETTE, { ...off, minThicknessPx: 2, protectedColorIndices: [2] }, visible);
    expect(result.grid[18]).toBe(0); expect(result.grid[21]).toBe(2); expect(result.grid[42]).toBe(3);
    expect(result.changedPixelsByRule.minThickness).toBe(1);
    expect(result.changedPixelsMask[18]).toBe(RULE_BITS.minThickness);
  });

  it('preserves a solid 2×2 patch in a 2×2 opening without translating it', () => {
    const grid = new Uint8Array(64); for (const p of [27, 28, 35, 36]) grid[p] = 1;
    const result = applyRules(grid, 8, 8, DEFAULT_PALETTE, { ...off, minThicknessPx: 2 });
    expect(result.grid).toEqual(grid);
  });

  it('removes checkerboards using surrounding counts and respects visible pixels', () => {
    const grid = new Uint8Array(64), visible = new Uint8Array(64);
    grid[27] = grid[36] = 1; visible[27] = 1;
    const result = applyRules(grid, 8, 8, DEFAULT_PALETTE, { ...off, removeCheckerboard: true }, visible);
    expect(result.grid[27]).toBe(1); expect(result.grid[36]).toBe(0);
    expect(result.changedPixelsMask[36]).toBe(RULE_BITS.removeCheckerboard);
  });

  it('excludes override locations from all rules and change accounting', () => {
    const grid = new Uint8Array(64), overrides = new Uint8Array(64); grid[27] = 1; overrides[27] = 1;
    const result = applyRules(grid, 8, 8, DEFAULT_PALETTE, { ...off, minRegionPx: 4, minThicknessPx: 2, removeCheckerboard: true }, undefined, undefined, overrides);
    expect(result.grid[27]).toBe(1); expect(result.changedPixelsMask[27]).toBe(0);
    expect(Object.values(result.changedPixelsByRule).reduce((sum, count) => sum + count, 0)).toBe(0);
  });

  it('is reproducible, emits only palette colors, and never mutates its input', () => {
    const grid = Uint8Array.from({ length: 64 }, (_, p) => (p * 13 + Math.floor(p / 8) * 3) % 4), before = grid.slice();
    const cfg = { connectVisibleEdges4: true, minThicknessPx: 2, minRegionPx: 4, removeCheckerboard: true };
    const first = applyRules(grid, 8, 8, DEFAULT_PALETTE, cfg), second = applyRules(grid, 8, 8, DEFAULT_PALETTE, cfg);
    expect(first).toEqual(second); expect(grid).toEqual(before);
    expect(first.grid.every(color => color < 4)).toBe(true);
    expect(() => applyRules(Uint8Array.of(16), 1, 1, DEFAULT_PALETTE, cfg)).toThrow('outside the palette');
  });

  it('keeps every original protected-color pixel unchanged through the complete rule sequence', () => {
    const cfg = { connectVisibleEdges4: true, minThicknessPx: 2, minRegionPx: 4, removeCheckerboard: true, protectedColorIndices: [1, 3] };
    for (let seed = 0; seed < 12; seed++) {
      const grid = Uint8Array.from({ length: 64 }, (_, p) => (p * (seed + 1) + Math.floor(p / 8) + Math.floor(p / 3)) % 5);
      const visible = Uint8Array.from({ length: 64 }, (_, p) => p % (seed + 2) === 0 ? 1 : 0);
      const result = applyRules(grid, 8, 8, DEFAULT_PALETTE, cfg, visible);
      grid.forEach((color, p) => {
        if (color === 1 || color === 3) { expect(result.grid[p]).toBe(color); expect(result.changedPixelsMask[p]).toBe(0); }
      });
    }
    expect(() => applyRules(new Uint8Array(64), 8, 8, DEFAULT_PALETTE, { ...cfg, protectedColorIndices: [99] })).toThrow('valid palette indices');
  });
});
