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
});
