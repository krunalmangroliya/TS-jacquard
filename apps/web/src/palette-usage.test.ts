import {describe, expect, it} from 'vitest';
import type {Palette} from '../../../packages/core/src/types';
import {analyzePaletteUsage, formatColorUsagePercentage} from './palette-usage';

function palette(colors: number[][]): Palette {
  return {entries: colors.map((rgb, index) => ({index, name: index === 0 ? 'Ground' : `Color ${index}`, displayRgb: [...rgb] as [number, number, number], exportRgb: [...rgb] as [number, number, number]}))};
}

describe('palette usage review', () => {
  it('flags the sample-sized red, black and brown fragments without changing colors', () => {
    const total = 1478 * 667, counts = [total - 14 - 12 - 361 - 10000, 14, 12, 361, 10000];
    const colors = palette([[255,255,255], [250,0,0], [0,0,0], [90,45,20], [255,0,0]]);
    const before = structuredClone({colors, counts});
    const result = analyzePaletteUsage(colors, counts, total)!;
    expect(result.rare.map(item => [item.entry.index, item.pixelCount])).toEqual([[2,12], [1,14], [3,361]]);
    expect(result.rare.find(item => item.entry.index === 1)?.suggestedTarget?.index).toBe(4);
    expect(result.rare.find(item => item.entry.index === 2)?.suggestedTarget).toBeUndefined();
    expect({colors, counts}).toEqual(before);
  });

  it('includes exactly 0.1%, excludes the next pixel, and keeps zero-count entries separate', () => {
    const colors = palette([[255,255,255], [1,1,1], [2,2,2], [3,3,3]]);
    const result = analyzePaletteUsage(colors, [99979,10,11,0], 100000)!;
    expect(result.rare.map(item => item.entry.index)).toEqual([1,2]);
    const boundary = analyzePaletteUsage(colors, [99799,100,101,0], 100000)!;
    expect(boundary.rare.map(item => item.entry.index)).toEqual([1]);
    expect(boundary.rare[0].percentage).toBe(.1);
    expect(boundary.unused.map(entry => entry.index)).toEqual([3]);
  });

  it('reports rare ground as information, while allowing common ground as a merge destination', () => {
    const colors = palette([[20,20,20], [21,21,21]]);
    const rareGround = analyzePaletteUsage(colors, [1,9999], 10000)!.rare[0];
    expect(rareGround.canMerge).toBe(false);
    expect(rareGround.suggestedTarget).toBeUndefined();
    expect(analyzePaletteUsage(colors, [9999,1], 10000)!.rare[0].suggestedTarget?.index).toBe(0);
  });

  it('does not mistake duplicate RGB entries or index 255 for an absent color', () => {
    const colors = palette(Array.from({length: 256}, (_, index) => index === 0 || index === 255 ? [12,34,56] : [240,240,240]));
    const counts = Array(256).fill(0); counts[0] = 999999; counts[255] = 1;
    const result = analyzePaletteUsage(colors, counts, 1000000)!;
    expect(result.rare[0].entry.index).toBe(255);
    expect(result.rare[0].suggestedTarget?.index).toBe(0);
    expect(result.unused).toHaveLength(254);
  });

  it('uses export RGB, rejects distant shades, and breaks equal-distance ties by usage then index', () => {
    const colors = palette([[240,240,240], [30,30,30], [31,30,30], [29,30,30], [30,29,30]]);
    colors.entries[1].displayRgb = [240,240,240];
    expect(analyzePaletteUsage(colors, [79799,1,10000,10200,0], 100000)!.rare[0].suggestedTarget?.index).toBe(3);
    expect(analyzePaletteUsage(colors, [79999,1,10000,10000,0], 100000)!.rare[0].suggestedTarget?.index).toBe(2);
    expect(analyzePaletteUsage(colors, [99999,1,0,0,0], 100000)!.rare[0].suggestedTarget).toBeUndefined();
  });

  it('does not suggest an unused, equally rare or less common destination', () => {
    const colors = palette([[255,255,255], [30,30,30], [31,30,30], [29,30,30], [30,29,30]]);
    expect(analyzePaletteUsage(colors, [99995,2,2,1,0], 100000)!.rare.find(item => item.entry.index === 1)?.suggestedTarget).toBeUndefined();
  });

  it('recomputes the warning after a manual merge and undo, preserving tiny details by default', () => {
    const colors = palette([[255,255,255], [255,0,0], [254,0,0]]), counts = [90000,9986,14];
    const original = analyzePaletteUsage(colors, counts, 100000)!;
    expect(original.rare[0].entry.index).toBe(2);
    expect(analyzePaletteUsage({entries: colors.entries.slice(0,2)}, [90000,10000], 100000)!.rare).toEqual([]);
    expect(analyzePaletteUsage(colors, counts, 100000)).toEqual(original);
  });

  it('keeps the ratio meaningful on large images and does not display a used pixel as zero percent', () => {
    const colors = palette([[255,255,255], [255,0,0]]);
    expect(analyzePaletteUsage(colors, [39960000,40000], 40000000)!.rare[0].pixelCount).toBe(40000);
    expect(analyzePaletteUsage(colors, [99,1], 100)!.rare).toEqual([]);
    expect(formatColorUsagePercentage(1 / 40000000 * 100)).toBe('<0.0001%');
  });

  it('withholds misleading results when counts are absent, incomplete, invalid or from a different-sized image', () => {
    const colors = palette([[255,255,255], [255,0,0]]);
    for (const counts of [undefined, [99], [99,0], [100,-1], [98.5,1.5], [99,NaN], [98,1,1]]) {
      expect(analyzePaletteUsage(colors, counts, 100)).toBeUndefined();
    }
    expect(analyzePaletteUsage(colors, [0,0], 0)).toBeUndefined();
    expect(analyzePaletteUsage(colors, [99,1,0,0], 100)?.rare).toEqual([]);
  });
});
