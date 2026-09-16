import { describe, expect, it } from 'vitest';
import { encodeRaster } from './raster';
import { render } from './render';
import { ruleSchema } from './schemas';
import { validateRuleConfig } from './rules';
import { DEFAULT_RASTER_RULES, type Palette, type RuleConfig } from './types';

const palette: Palette = { entries: Array.from({ length: 256 }, (_, index) => ({ index, name: `Color ${index}`, displayRgb: [index, index, index], exportRgb: [index, index, index] })) };
const empty = { nodes: {}, edges: {}, faceColors: {} };
const base = { ...DEFAULT_RASTER_RULES, outlineColorIndex: 255, outlineAlgorithm: 'conservative' } as const;
const preserve: RuleConfig = { ...base, rasterResize: 'preserve-outline' };
const repair: RuleConfig = { ...base, repairOutlineGaps: true };
function output(source: Uint8Array, sw: number, sh: number, w: number, h: number, rules: RuleConfig = DEFAULT_RASTER_RULES, overrides: { x: number; y: number; colorIndex: number }[] = []) {
  return render(empty, [], { w: sw, h: sh }, palette, w, h, rules, overrides, { type: 'none' }, encodeRaster(sw, sh, source));
}
function brokenSample(): Uint8Array {
  const source = new Uint8Array(81);
  for (let x = 0; x < 9; x++) source[(x >= 3 && x <= 5 ? 3 : 4) * 9 + x] = 255;
  source[3 * 9 + 2] = 255; source[3 * 9 + 6] = 255;
  return source;
}

describe('conservative outline proposals', () => {
  it('repairs a missed sampled gap with anchored source evidence, but keeps a real source gap', () => {
    const source = brokenSample();
    const result = output(source, 9, 9, 3, 3, repair);
    expect([...result.grid]).toEqual([0, 0, 0, 255, 255, 255, 0, 0, 0]);
    expect(result.report.changedPixelsByRule.repairOutlineGaps).toBe(1);
    source[3 * 9 + 4] = 0;
    expect(output(source, 9, 9, 3, 3, repair).grid).toEqual(output(source, 9, 9, 3, 3).grid);
  });

  it('recovers wholly missed thin ink without expanding a neighboring sampled stroke', () => {
    const source = new Uint8Array(225);
    for (let y = 0; y < 15; y++) source[y * 15 + 6] = 255;
    const result = output(source, 15, 15, 5, 5, preserve);
    expect([...result.grid]).toEqual(Array.from({ length: 25 }, (_, p) => p % 5 === 2 ? 255 : 0));
    for (let y = 0; y < 15; y++) source[y * 15 + 4] = 255;
    const adjacent = output(source, 15, 15, 5, 5, preserve);
    expect(adjacent.grid).toEqual(output(source, 15, 15, 5, 5).grid);
    expect(adjacent.report.changedPixelsByRule.preserveOutline).toBe(0);
  });

  it('does not turn missed source flecks into new singleton or two-pixel islands', () => {
    for (const length of [3, 6]) {
      const source = new Uint8Array(225);
      for (let y = 3; y < 3 + length; y++) source[y * 15 + 6] = 255;
      expect(output(source, 15, 15, 5, 5, preserve).grid).toEqual(new Uint8Array(25));
    }
  });

  it('abstains at a source crossing where the competing color still connects diagonally', () => {
    const source = brokenSample();
    source[3 * 9 + 2] = 0; source[3 * 9 + 6] = 0;
    const old = output(source, 9, 9, 3, 3, { ...repair, outlineAlgorithm: 'legacy' });
    expect(old.grid[4]).toBe(255);
    expect(output(source, 9, 9, 3, 3, repair).grid[4]).toBe(0);
  });

  it('does not amplify repair proposals when preservation is enabled', () => {
    const source = new Uint8Array(21 * 15);
    for (let y = 0; y < 15; y++) source[y * 21 + 3] = 255;
    for (let x = 12; x < 21; x++) source[(x >= 15 && x <= 17 ? 6 : 7) * 21 + x] = 255;
    source[6 * 21 + 14] = 255; source[6 * 21 + 18] = 255;
    const nearest = output(source, 21, 15, 7, 5), p = output(source, 21, 15, 7, 5, preserve), r = output(source, 21, 15, 7, 5, repair);
    const combined = output(source, 21, 15, 7, 5, { ...preserve, repairOutlineGaps: true });
    expect(p.report.changedPixelsByRule.preserveOutline).toBeGreaterThan(0);
    expect(r.report.changedPixelsByRule.repairOutlineGaps).toBeGreaterThan(0);
    expect(combined.report.changedPixelsByRule.repairOutlineGaps).toBeLessThanOrEqual(r.report.changedPixelsByRule.repairOutlineGaps);
    for (let i = 0; i < nearest.grid.length; i++) if (combined.grid[i] !== nearest.grid[i]) expect(p.grid[i] !== nearest.grid[i] || r.grid[i] !== nearest.grid[i]).toBe(true);
  });

  it('retains competing-color one-pixel channels and marked decorative dots', () => {
    const channel = brokenSample();
    for (let y = 0; y < 9; y++) channel[y * 9 + 4] = 7;
    // Ink reconnects around the narrow channel above its sampled center.
    for (let x = 3; x <= 5; x++) channel[3 * 9 + x] = 255;
    const baseline = output(channel, 9, 9, 3, 3);
    expect(baseline.grid[1]).toBe(7); expect(baseline.grid[4]).toBe(7); expect(baseline.grid[7]).toBe(7);
    expect(output(channel, 9, 9, 3, 3, repair).grid).toEqual(baseline.grid);
    const dot = brokenSample(); dot[4 * 9 + 4] = 7;
    expect(output(dot, 9, 9, 3, 3, repair).grid[4]).toBe(7);
  });

  it('checks joint edits so a batch cannot isolate a remaining neighboring detail', () => {
    const source = new Uint8Array(21 * 15);
    // Three missed vertical lines surround a sampled 2-pixel color-7 detail.
    for (let y = 0; y < 15; y++) for (const x of [6, 9, 12]) source[y * 21 + x] = 255;
    for (let y = 6; y < 12; y++) for (let x = 6; x < 15; x++) if (source[y * 21 + x] !== 255) source[y * 21 + x] = 7;
    const before = output(source, 21, 15, 7, 5), after = output(source, 21, 15, 7, 5, { ...preserve, repairOutlineGaps: true });
    const legacy = output(source, 21, 15, 7, 5, { ...preserve, outlineAlgorithm: 'legacy' });
    expect([...before.grid].some((color, p) => color === 7 && legacy.grid[p] !== 7)).toBe(true);
    for (let p = 0; p < before.grid.length; p++) if (before.grid[p] === 7) expect(after.grid[p]).toBe(7);
  });

  it('rejects connecting the wrong original stroke in an adjacent sampling footprint', () => {
    const source = new Uint8Array(225);
    for (let x = 0; x < 15; x++) source[5 * 15 + x] = 255;
    source[7 * 15 + 2] = 255; source[7 * 15 + 12] = 255;
    // The center source line visits the neighbors' footprints, but the sampled
    // endpoints belong to separate components instead of this line.
    expect(output(source, 15, 15, 3, 3, { ...repair, outlineAlgorithm: 'legacy' }).grid[4]).toBe(255);
    expect(output(source, 15, 15, 3, 3, repair).grid[4]).toBe(0);
  });

  it('honors original color/rectangle scope, protection and overrides at index 255', () => {
    const source = brokenSample();
    for (const extra of [{ cleanupColorIndices: [] }, { cleanupColorIndices: [255] }, { protectedColorIndices: [0] }, { cleanupRegion: { x: 0, y: 0, w: 1, h: 1 / 3 } }]) {
      expect(output(source, 9, 9, 3, 3, { ...repair, ...extra }).grid[4]).toBe(0);
    }
    const result = output(source, 9, 9, 3, 3, repair, [{ x: 1, y: 1, colorIndex: 8 }]);
    expect(result.grid[4]).toBe(8); expect(result.report.changedPixelsMask[4]).toBe(0);
    expect(result.report.colorPixelCounts?.reduce((a, b) => a + b, 0)).toBe(9);
    expect(result.report.colorPixelCounts?.[255]).toBe(2); expect(result.report.colorPixelCounts?.[8]).toBe(1);
  });

  it('is invariant to palette order and never uses palette position as a color preference', () => {
    const source = brokenSample(), mapping = Array.from({ length: 256 }, (_, i) => 255 - i);
    const original = output(source, 9, 9, 3, 3, repair);
    const permuted = output(source.map(c => mapping[c]), 9, 9, 3, 3, { ...repair, outlineColorIndex: mapping[255] });
    expect([...permuted.grid]).toEqual([...original.grid].map(c => mapping[c]));
  });

  it('does not infer an outline connection across a repeat seam', () => {
    const source = new Uint8Array(225);
    for (let x = 0; x < 15; x++) source[(x < 3 ? 6 : 7) * 15 + x] = 255;
    const baseline = output(source, 15, 15, 5, 5);
    const result = render(empty, [], { w: 15, h: 15 }, palette, 5, 5, repair, [], { type: 'straight' }, encodeRaster(15, 15, source));
    expect(result.grid).toEqual(baseline.grid);
    expect(result.report.warnings.some(w => w.includes('repeat joins'))).toBe(true);
  });

  it.each([[9, 9], [18, 18], [18, 6]])('keeps same-size and unsupported scaling unchanged at %i by %i', (w, h) => {
    const source = brokenSample();
    expect(output(source, 9, 9, w, h, { ...preserve, repairOutlineGaps: true }).grid).toEqual(output(source, 9, 9, w, h).grid);
  });

  it('retains legacy output for saved rules without an algorithm version', () => {
    const source = new Uint8Array(81);
    for (let y = 0; y < 9; y++) { source[y * 9 + 3] = 255; source[y * 9 + 1] = 255; }
    const rules: RuleConfig = { ...DEFAULT_RASTER_RULES, rasterResize: 'preserve-outline', repairOutlineGaps: true, outlineColorIndex: 255 };
    const implicit = output(source, 9, 9, 3, 3, rules), explicit = output(source, 9, 9, 3, 3, { ...rules, outlineAlgorithm: 'legacy' });
    expect(implicit.grid).toEqual(explicit.grid); expect(implicit.report.changedPixelsMask).toEqual(explicit.report.changedPixelsMask);
    expect(implicit.report.changedPixelsByRule).toEqual(explicit.report.changedPixelsByRule);
    expect([...implicit.grid]).toEqual([255, 255, 0, 255, 255, 0, 255, 255, 0]);
    expect(output(source, 9, 9, 3, 3, { ...rules, outlineAlgorithm: 'conservative' }).grid).not.toEqual(implicit.grid);
  });

  it('persists and validates the explicit algorithm version', () => {
    expect(ruleSchema.parse(repair)).toEqual(repair);
    expect(() => ruleSchema.parse({ ...repair, outlineAlgorithm: 'automatic' })).toThrow();
    expect(() => validateRuleConfig({ ...repair, outlineAlgorithm: 'automatic' } as unknown as RuleConfig, palette)).toThrow(/algorithm/);
  });
});
