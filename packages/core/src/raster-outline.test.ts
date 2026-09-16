import { describe, expect, it } from 'vitest';
import { encodeRaster } from './raster';
import { render } from './render';
import { applyRules, RULE_BITS, validateRuleConfig } from './rules';
import { ruleSchema } from './schemas';
import { DEFAULT_RASTER_RULES, type Palette, type RuleConfig } from './types';

const palette: Palette = { entries: Array.from({ length: 256 }, (_, index) => ({ index, name: `Color ${index}`, displayRgb: [index, index, index], exportRgb: [index, index, index] })) };
const geometry = { nodes: {}, edges: {}, faceColors: {} };
function output(source: Uint8Array, sw: number, sh: number, w: number, h: number, rules: RuleConfig = DEFAULT_RASTER_RULES, overrides: { x: number; y: number; colorIndex: number }[] = []) {
  return render(geometry, [], { w: sw, h: sh }, palette, w, h, rules, overrides, { type: 'none' }, encodeRaster(sw, sh, source));
}
const outlineRules: RuleConfig = { ...DEFAULT_RASTER_RULES, rasterResize: 'preserve-outline', outlineColorIndex: 255 };
const repairRules: RuleConfig = { ...DEFAULT_RASTER_RULES, repairOutlineGaps: true, outlineColorIndex: 255 };

describe('source-supported outline assistance', () => {
  it('retains a thin source line missed by center sampling without adding colors or widening it', () => {
    const source = new Uint8Array(81);
    for (let y = 0; y < 9; y++) source[y * 9] = 255;
    expect([...output(source, 9, 9, 3, 3).grid]).toEqual(Array(9).fill(0));
    const preserved = output(source, 9, 9, 3, 3, outlineRules);
    expect([...preserved.grid]).toEqual([255, 0, 0, 255, 0, 0, 255, 0, 0]);
    expect(preserved.report.changedPixelsByRule.preserveOutline).toBe(3);
    expect(preserved.report.changedPixelsMask[3]).toBe(RULE_BITS.preserveOutline);
    expect(preserved.report.colorsUsed).toEqual([0, 255]);
  });

  it('repairs one missed output pixel only when a continuous original outline supports it', () => {
    const source = new Uint8Array(81);
    for (let x = 0; x < 9; x++) source[(x >= 3 && x <= 5 ? 3 : 4) * 9 + x] = 255;
    expect([...output(source, 9, 9, 3, 3).grid]).toEqual([0, 0, 0, 255, 0, 255, 0, 0, 0]);
    const repaired = output(source, 9, 9, 3, 3, repairRules);
    expect([...repaired.grid]).toEqual([0, 0, 0, 255, 255, 255, 0, 0, 0]);
    expect(repaired.report.changedPixelsByRule.repairOutlineGaps).toBe(1);
    expect(repaired.report.changedPixelsMask[4]).toBe(RULE_BITS.repairOutlineGaps);
    source[3 * 9 + 4] = 0;
    const genuineGap = output(source, 9, 9, 3, 3, repairRules);
    expect(genuineGap.grid[4]).toBe(0); expect(genuineGap.report.changedPixelsByRule.repairOutlineGaps).toBe(0);
  });

  it('retains existing and recovered outline through older aggressive cleanup settings', () => {
    const source = new Uint8Array(81);
    for (let y = 0; y < 9; y++) { source[y * 9] = 255; source[y * 9 + 7] = 255; }
    const preserved = output(source, 9, 9, 3, 3, { ...outlineRules, minThicknessPx: 2, minRegionPx: 6, removeCheckerboard: true, connectVisibleEdges4: true });
    for (let y = 0; y < 3; y++) { expect(preserved.grid[y * 3]).toBe(255); expect(preserved.grid[y * 3 + 2]).toBe(255); }
    expect(preserved.report.changedPixelsByRule.preserveOutline).toBe(3);
    expect(preserved.report.changedPixelsByRule.connectVisibleEdges4).toBe(0);
  });

  it('keeps an existing sampled gap between separate parallel source lines', () => {
    const source = new Uint8Array(81);
    for (let x = 0; x < 9; x++) for (const y of [1, 3, 7]) source[y * 9 + x] = 255;
    const result = output(source, 9, 9, 3, 3, { ...outlineRules, repairOutlineGaps: true });
    expect([...result.grid]).toEqual([255, 255, 255, 0, 0, 0, 255, 255, 255]);
  });

  it.each([[9, 9], [18, 18], [18, 6]])('leaves native/enlarged sampling exact at %i by %i', (w, h) => {
    const source = Uint8Array.from({ length: 81 }, (_, p) => p % 4 === 0 ? 255 : p % 3);
    expect(output(source, 9, 9, w, h, { ...outlineRules, repairOutlineGaps: true }).grid).toEqual(output(source, 9, 9, w, h).grid);
  });

  it('honors frozen color and rectangle scopes, protected color255, and manual overrides', () => {
    const source = new Uint8Array(81);
    for (let y = 0; y < 9; y++) source[y * 9] = 255;
    expect([...output(source, 9, 9, 3, 3, { ...outlineRules, cleanupRegion: { x: 0, y: 0, w: 1, h: 1 / 3 } }).grid]).toEqual([255, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(output(source, 9, 9, 3, 3, { ...outlineRules, cleanupColorIndices: [] }).grid).toEqual(new Uint8Array(9));
    expect(output(source, 9, 9, 3, 3, { ...outlineRules, protectedColorIndices: [0] }).grid).toEqual(new Uint8Array(9));
    const overridden = output(source, 9, 9, 3, 3, outlineRules, [{ x: 0, y: 1, colorIndex: 7 }]);
    expect(overridden.grid[3]).toBe(7); expect(overridden.report.changedPixelsMask[3]).toBe(0);
    const dots = new Uint8Array(25); dots[12] = 255;
    expect(output(dots, 5, 5, 5, 5, { ...DEFAULT_RASTER_RULES, minRegionPx: 3, protectedColorIndices: [255] }).grid).toEqual(dots);
  });

  it('never repairs excluded or manually overridden gaps and does not iterate into wider gaps', () => {
    const source = new Uint8Array(81);
    for (let x = 0; x < 9; x++) source[(x >= 3 && x <= 5 ? 3 : 4) * 9 + x] = 255;
    for (const extra of [{ cleanupColorIndices: [255] }, { protectedColorIndices: [0] }, { cleanupRegion: { x: 0, y: 0, w: 1, h: 1 / 3 } }]) {
      expect(output(source, 9, 9, 3, 3, { ...repairRules, ...extra }).grid[4]).toBe(0);
    }
    const manual = output(source, 9, 9, 3, 3, repairRules, [{ x: 1, y: 1, colorIndex: 0 }]);
    expect(manual.grid[4]).toBe(0); expect(manual.report.changedPixelsMask[4]).toBe(0);
    const wide = new Uint8Array(108);
    for (let x = 0; x < 12; x++) wide[(x >= 3 && x <= 8 ? 3 : 4) * 12 + x] = 255;
    expect(output(wide, 12, 9, 4, 3, repairRules).grid).toEqual(output(wide, 12, 9, 4, 3).grid);
  });
});

describe('cleanup scope and validation', () => {
  it('cleans selected noise while preserving intentional dots of other colors and outside the region', () => {
    const grid = new Uint8Array(49); grid[2 * 7 + 1] = 1; grid[4 * 7 + 1] = 2; grid[2 * 7 + 5] = 1;
    const result = applyRules(grid, 7, 7, palette, { ...DEFAULT_RASTER_RULES, minRegionPx: 2, cleanupColorIndices: [1], cleanupRegion: { x: 0, y: 0, w: 0.5, h: 1 } }, undefined, { type: 'none' });
    expect(result.grid[2 * 7 + 1]).toBe(0); expect(result.grid[4 * 7 + 1]).toBe(2); expect(result.grid[2 * 7 + 5]).toBe(1);
    for (let p = 0; p < grid.length; p++) if (p !== 2 * 7 + 1) expect(result.grid[p]).toBe(grid[p]);
  });

  it('keeps every rule mutation inside the original scope, including vector bridges', () => {
    const grid = Uint8Array.from({ length: 64 }, (_, p) => ((p % 8) + Math.floor(p / 8)) % 2), visible = new Uint8Array(64);
    visible[27] = 1; visible[36] = 1;
    const rules: RuleConfig = { minRegionPx: 4, minThicknessPx: 2, removeCheckerboard: true, connectVisibleEdges4: true, cleanupColorIndices: [0], cleanupRegion: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } };
    const result = applyRules(grid, 8, 8, palette, rules, visible, { type: 'none' });
    for (let p = 0; p < grid.length; p++) {
      const x = p % 8, y = Math.floor(p / 8);
      if (grid[p] !== 0 || x < 2 || x >= 6 || y < 2 || y >= 6 || visible[p]) expect(result.grid[p]).toBe(grid[p]);
    }
    expect(applyRules(grid, 8, 8, palette, { ...rules, cleanupColorIndices: [] }, visible).grid).toEqual(grid);
  });

  it('persists valid options and rejects invalid palette references and normalized regions', () => {
    const valid = { ...outlineRules, repairOutlineGaps: true, cleanupColorIndices: [0, 255], cleanupRegion: { x: 0.2, y: 0.1, w: 0.8, h: 0.9 } };
    expect(ruleSchema.parse(valid)).toEqual(valid); expect(() => validateRuleConfig(valid, palette)).not.toThrow();
    const smallPalette = { entries: palette.entries.slice(0, 2) };
    expect(() => validateRuleConfig(outlineRules, smallPalette)).toThrow(/Outline color/);
    expect(() => validateRuleConfig({ ...DEFAULT_RASTER_RULES, cleanupColorIndices: [2] }, smallPalette)).toThrow(/Cleanup colors/);
    for (const cleanupRegion of [{ x: -0.1, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 1 }, { x: 0.5, y: 0, w: 0.6, h: 1 }, { x: 0, y: NaN, w: 1, h: 1 }]) {
      expect(() => ruleSchema.parse({ ...DEFAULT_RASTER_RULES, cleanupRegion })).toThrow();
      expect(() => validateRuleConfig({ ...DEFAULT_RASTER_RULES, cleanupRegion }, palette)).toThrow(/region/);
    }
    for (const rules of [{ ...outlineRules, outlineColorIndex: undefined }, { ...repairRules, outlineColorIndex: 256 }, { ...DEFAULT_RASTER_RULES, cleanupColorIndices: [-1] }]) expect(() => ruleSchema.parse(rules)).toThrow();
  });
});
