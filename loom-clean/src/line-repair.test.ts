import { describe, expect, it } from 'vitest';
import { repairSourceLines, type LineRepairOptions } from './line-repair';
import type { IndexedImage } from './types';

const options = (extra: Partial<LineRepairOptions> = {}): LineRepairOptions => ({
  strength: 'balanced', outlineColor: 1, protectedColors: [], repeatX: false, repeatY: false, ...extra,
});
const image = (w: number, h: number): IndexedImage => ({ width: w, height: h,
  pixels: new Uint8Array(w * h), palette: [[240, 220, 40], [0, 0, 128], [220, 30, 130], [30, 180, 40]],
});
const ink = (im: IndexedImage, x: number, y: number, c = 2) => { im.pixels[y * im.width + x] = c; };
const nearest = (source: IndexedImage, width: number, height: number): IndexedImage => {
  const out = image(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    out.pixels[y * width + x] = source.pixels[Math.floor((y + 0.5) * source.height / height) * source.width +
      Math.floor((x + 0.5) * source.width / width)];
  return out;
};
function line(gaps = 3, color = 2) {
  const source = image(39, 27);
  for (let x = 4; x <= 31; x++) ink(source, x, 13, color);
  for (let x = 12; x < (4 + gaps) * 3; x++) { ink(source, x, 13, 0); ink(source, x, 12, color); }
  return { source, baseline: nearest(source, 13, 9) };
}

describe('source-space multicolor stroke reconstruction', () => {
  it.each([1, 2, 3])('repairs a %i-cell colored line break using the continuous source', gaps => {
    const { source, baseline } = line(gaps);
    const out = repairSourceLines(source, baseline, options());
    for (let x = 4; x < 4 + gaps; x++) {
      expect(baseline.pixels[4 * 13 + x]).toBe(0);
      expect(out.pixels[4 * 13 + x]).toBe(2);
      expect(out.additions[4 * 13 + x]).toBe(1);
    }
    expect(out.repairedPixels).toBe(gaps);
    expect(out.budgetExhausted).toBe(false);
  });

  it('projects a curved source path instead of drawing a chord across its interior', () => {
    const source = image(39, 27);
    for (let x = 4; x <= 10; x++) ink(source, x, 13);
    for (let x = 22; x <= 31; x++) ink(source, x, 13);
    for (const [x, y] of [[11, 12], [12, 11], [12, 10], [13, 9], [14, 9], [15, 9],
      [16, 9], [17, 9], [18, 9], [19, 9], [20, 10], [21, 11], [22, 12]]) ink(source, x, y);
    const baseline = nearest(source, 13, 9), out = repairSourceLines(source, baseline, options());
    for (let x = 4; x <= 6; x++) {
      expect(out.pixels[3 * 13 + x]).toBe(2);
      expect(out.pixels[4 * 13 + x]).toBe(0);
    }
    expect(out.repairedPixels).toBe(3);
  });

  it('limits wider four-cell gaps to strong mode', () => {
    const { source, baseline } = line(4);
    expect(repairSourceLines(source, baseline, options()).repairedPixels).toBe(0);
    const strong = repairSourceLines(source, baseline, options({ strength: 'strong' }));
    expect(strong.repairedPixels).toBe(4);
  });

  it('does not connect real source gaps, even if target ends are aligned', () => {
    const { source } = line(3);
    for (let y = 0; y < source.height; y++) ink(source, 16, y, 0);
    const baseline = nearest(source, 13, 9), out = repairSourceLines(source, baseline, options());
    expect(out.repairedPixels).toBe(0);
    expect(out.pixels).toEqual(baseline.pixels);
  });

  it('does not turn an isotropic connected source speckle network into strokes', () => {
    const source = image(39, 27);
    for (let y = 0; y < 27; y++) for (let x = 0; x < 39; x++) if ((x + y) % 2 === 0) ink(source, x, y);
    for (let y = 0; y < 9; y++) for (let x = 0; x < 13; x++) ink(source, x * 3 + 1, y * 3 + 1, 0);
    for (const x of [2, 3, 7, 8]) ink(source, x * 3 + 1, 13);
    const baseline = nearest(source, 13, 9), out = repairSourceLines(source, baseline, options());
    expect(out.reviewedCandidates).toBeGreaterThan(0);
    expect(out.repairedPixels).toBe(0);
  });

  it('does not join distinct parallel contours through a distant source connection', () => {
    const source = image(39, 39);
    for (let y = 4; y < 34; y++) { ink(source, 13, y); ink(source, 19, y); }
    for (let x = 13; x <= 19; x++) ink(source, x, 4);
    const baseline = nearest(source, 13, 13), out = repairSourceLines(source, baseline, options());
    expect(out.pixels).toEqual(baseline.pixels);
    expect(out.repairedPixels).toBe(0);
  });

  it('preserves a one-cell ring hole and a differently colored dot', () => {
    const source = image(27, 27);
    for (let y = 10; y <= 16; y++) for (let x = 10; x <= 16; x++) {
      if (x <= 11 || x >= 15 || y <= 11 || y >= 15) ink(source, x, y, 1);
    }
    ink(source, 13, 13, 3);
    const baseline = nearest(source, 9, 9), out = repairSourceLines(source, baseline, options({ strength: 'strong' }));
    expect(out.pixels[4 * 9 + 4]).toBe(3);
    expect(out.repairedPixels).toBe(0);
  });

  it('preserves a competing thin ink crossing the target repair path', () => {
    const { source } = line(3);
    // The horizontal source stroke lies at y12; another ink takes the target
    // sample on the lower side of the same footprint without touching that stroke.
    for (let y = 13; y <= 19; y++) ink(source, 16, y, 3);
    for (let y = 4; y <= 11; y++) ink(source, 16, y, 3);
    const baseline = nearest(source, 13, 9), out = repairSourceLines(source, baseline, options());
    expect(out.pixels[4 * 13 + 5]).toBe(3);
    expect(out.repairedPixels).toBe(0);
  });

  it('neither removes nor expands protected colors and respects disabled repair', () => {
    const { source, baseline } = line(3);
    for (const opts of [options({ protectedColors: [2] }), options({ protectedColors: [0] }), options({ outlineColor: null })]) {
      const out = repairSourceLines(source, baseline, opts);
      expect(out.pixels).toEqual(baseline.pixels);
      expect(out.repairedPixels).toBe(0);
    }
  });

  it('uses wrapped source coordinates when the stroke crosses a repeat seam', () => {
    const source = image(27, 21);
    for (const x of [19, 20, 21, 22, 23, 24, 25, 26, 0, 1, 2, 3, 4, 5, 6, 7]) ink(source, x, 10);
    for (const x of [24, 25, 26, 0, 1, 2]) { ink(source, x, 10, 0); ink(source, x, 9); }
    const baseline = nearest(source, 9, 7);
    const plain = repairSourceLines(source, baseline, options());
    const repeat = repairSourceLines(source, baseline, options({ repeatX: true }));
    expect(plain.repairedPixels).toBe(0);
    expect(repeat.pixels[3 * 9]).toBe(2);
    expect(repeat.pixels[3 * 9 + 8]).toBe(2);
    expect(repeat.repairedPixels).toBe(2);
  });

  it('preserves inputs and makes deterministic frozen-baseline proposals', () => {
    const { source, baseline } = line(3), src = source.pixels.slice(), base = baseline.pixels.slice();
    const first = repairSourceLines(source, baseline, options()), second = repairSourceLines(source, baseline, options());
    expect(first.pixels).toEqual(second.pixels);
    expect(first.additions).toEqual(second.additions);
    expect(source.pixels).toEqual(src); expect(baseline.pixels).toEqual(base);
    expect(first.repairedPixels).toBe(first.additions.reduce((a, b) => a + b, 0));
  });
});
