import { describe, expect, it } from 'vitest';
import { resolveSize } from './size';
import { DEFAULT_PROFILE } from './types';
describe('loom dimensions', () => {
  const bounds = { w: 3000, h: 2400 };
  it('preserves physical proportions on non-square loom pixels', () => {
    expect(resolveSize(bounds, DEFAULT_PROFILE, { mode: 'physical', unit: 'in', width: 2.5, linkAspect: true })).toMatchObject({ widthPx: 150, heightPx: 96, widthIn: 2.5, heightIn: 2, warnings: [] });
    expect(resolveSize(bounds, DEFAULT_PROFILE, { mode: 'physical', unit: 'cm', height: 5.08, linkAspect: true })).toMatchObject({ widthPx: 150, heightPx: 96 });
  });
  it('warns for hook remainders and suggests exact divisors', () => {
    expect(resolveSize(bounds, DEFAULT_PROFILE, { mode: 'fitAcross', n: 7 })).toMatchObject({ widthPx: 342, suggestedWidths: [300, 400] });
  });
  it('rejects invalid or unbounded allocations without changing valid explicit sizes', () => {
    for (const width of [0, -1, NaN, Infinity]) expect(() => resolveSize(bounds, DEFAULT_PROFILE, { mode: 'physical', unit: 'in', width, linkAspect: true })).toThrow();
    expect(() => resolveSize(bounds, DEFAULT_PROFILE, { mode: 'grid', widthPx: 40000001, heightPx: 1, linkAspect: false })).toThrow();
    expect(resolveSize(bounds, DEFAULT_PROFILE, { mode: 'grid', widthPx: 300, heightPx: 200, linkAspect: false }).heightPx).toBe(200);
  });
  it('uses confirmed source pixel aspect exactly once for a prepared loom grid', () => {
    const prepared = { w: 1478, h: 384, pixelAspect: 200 / 76 }, sourceProfile = { ...DEFAULT_PROFILE, epi: 200, ppi: 76 };
    expect(resolveSize(prepared, sourceProfile, { mode: 'grid', widthPx: 1478, linkAspect: true })).toMatchObject({ widthPx: 1478, heightPx: 384 });
    expect(resolveSize(prepared, sourceProfile, { mode: 'grid', heightPx: 384, linkAspect: true })).toMatchObject({ widthPx: 1478, heightPx: 384 });
    expect(resolveSize(prepared, { ...DEFAULT_PROFILE, epi: 96, ppi: 52 }, { mode: 'grid', widthPx: 1478, linkAspect: true }).heightPx).toBe(547);
    expect(resolveSize(prepared, sourceProfile, { mode: 'physical', unit: 'in', width: 7.39, linkAspect: true })).toMatchObject({ widthPx: 1478, heightPx: 384 });
  });
  it('retains legacy artwork dimensions and allows an explicit square-pixel interpretation', () => {
    const input = { mode: 'grid', widthPx: 1478, linkAspect: true } as const;
    expect(resolveSize(bounds, DEFAULT_PROFILE, input)).toEqual(resolveSize({ ...bounds, pixelAspect: 1 }, DEFAULT_PROFILE, input));
  });
  it('keeps unknown-density prepared grids explicit and does not invent aspect warnings', () => {
    const prepared = { w: 1478, h: 384, pixelAspect: null };
    const explicit = resolveSize(prepared, DEFAULT_PROFILE, { mode: 'grid', widthPx: 1478, heightPx: 384, linkAspect: false });
    expect(explicit).toMatchObject({ widthPx: 1478, heightPx: 384 });
    expect(explicit.warnings.some(warning => warning.includes('differs from the master'))).toBe(false);
    expect(explicit.warnings.some(warning => warning.includes('Source density is unknown'))).toBe(true);
    expect(() => resolveSize(prepared, DEFAULT_PROFILE, { mode: 'grid', widthPx: 1478, linkAspect: true })).toThrow('source EPI and PPI');
    expect(() => resolveSize(prepared, DEFAULT_PROFILE, { mode: 'physical', unit: 'in', width: 7.39, linkAspect: true })).toThrow('source EPI and PPI');
    expect(() => resolveSize(prepared, DEFAULT_PROFILE, { mode: 'fitAcross', n: 2 })).toThrow('source EPI and PPI');
  });
  it('rejects invalid physical source pixel aspects', () => {
    for (const pixelAspect of [0, -1, NaN, Infinity]) expect(() => resolveSize({ ...bounds, pixelAspect }, DEFAULT_PROFILE, { mode: 'grid', widthPx: 300, heightPx: 200, linkAspect: false })).toThrow('Source pixel aspect');
  });
});
