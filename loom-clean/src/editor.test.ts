import { describe, expect, it } from 'vitest';
import { drawLine, floodFill, replaceColor } from './editor';
import type { IndexedImage } from './types';

const fixture = (): IndexedImage => ({ width: 3, height: 3, palette: [[0, 0, 0], [255, 255, 255], [255, 0, 0]], pixels: Uint8Array.from([0, 1, 0, 0, 1, 1, 1, 0, 0]) });
describe('indexed editing', () => {
  it('fills only the clicked connected region, retaining diagonal and separated islands', () => {
    const source = fixture();
    const result = floodFill(source, 0, 0, 2);
    expect([...result.pixels]).toEqual([2, 1, 0, 2, 1, 1, 1, 0, 0]);
    expect(source.pixels[0]).toBe(0);
    expect(result.palette).toBe(source.palette);
  });
  it('distinguishes global replacement from region fill', () => {
    expect([...replaceColor(fixture(), 0, 2).pixels]).toEqual([2, 1, 2, 2, 1, 1, 1, 2, 2]);
  });
  it('draws a continuous line even when pointer movement skips pixels', () => {
    const result = drawLine(fixture(), 0, 0, 2, 2, 2);
    expect([result.pixels[0], result.pixels[4], result.pixels[8]]).toEqual([2, 2, 2]);
  });
  it('does not wrap fills across image row boundaries', () => {
    const source = { ...fixture(), pixels: Uint8Array.from([1, 1, 0, 0, 1, 1, 1, 1, 1]) };
    expect(floodFill(source, 2, 0, 2).pixels[3]).toBe(0);
    expect(floodFill(source, -1, 0, 2)).toBe(source);
  });
});
