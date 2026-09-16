import { describe, expect, it } from 'vitest';
import { MAX_PREVIEW_PIXELS, overviewDimensions, previewTiles, renderPreviewRegion, visibleSourceRect } from './preview';
import type { IndexedImage } from './types';

const source: IndexedImage = { width: 3, height: 2, pixels: Uint8Array.from([0, 1, 2, 2, 1, 0]), palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255]] };
describe('bounded indexed previews', () => {
  it('caps an entire 32.8-million-pixel source overview at one million RGBA pixels', () => {
    const size = overviewDimensions(6000, 5472);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_PREVIEW_PIXELS);
    expect(size.width).toBeLessThanOrEqual(1536);
    expect(overviewDimensions(3, 2)).toEqual({ width: 3, height: 2 });
  });
  it('crops only the visible source and respects cloth aspect ratio', () => {
    expect(visibleSourceRect({ width: 100, height: 80 }, { width: 50, height: 40 }, { x: -20, y: -30, scale: 2 })).toEqual({ x: 10, y: 15, width: 25, height: 20 });
    expect(visibleSourceRect({ width: 100, height: 80 }, { width: 50, height: 40 }, { x: -20, y: -40, scale: 2 }, 2)).toEqual({ x: 10, y: 10, width: 25, height: 10 });
    expect(visibleSourceRect(source, { width: 50, height: 40 }, { x: 100, y: 100, scale: 2 })).toBeNull();
  });
  it('tiles a large visible crop without gaps or oversized RGBA buffers', () => {
    const tiles = [...previewTiles({ x: 7, y: 13, width: 3120, height: 1824 })];
    expect(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0)).toBe(3120 * 1824);
    expect(tiles.every(tile => tile.width * tile.height <= MAX_PREVIEW_PIXELS)).toBe(true);
    expect(tiles.at(-1)).toEqual({ x: 3079, y: 1037, width: 48, height: 800 });
  });
  it('retains exact native RGB values for a zoomed source crop', () => {
    expect([...renderPreviewRegion(source, { x: 1, y: 0, width: 2, height: 2 }, 2, 2)]).toEqual([0, 255, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
  });
  it('area-averages small previews instead of dropping thin colored pixels', () => {
    expect([...renderPreviewRegion(source, { x: 0, y: 0, width: 3, height: 2 }, 1, 1)]).toEqual([85, 85, 85, 255]);
    const strip = { ...source, width: 3, height: 1, pixels: Uint8Array.from([0, 1, 2]) };
    expect([...renderPreviewRegion(strip, { x: 0, y: 0, width: 3, height: 1 }, 2, 1)]).toEqual([170, 85, 0, 255, 0, 85, 170, 255]);
  });
  it('distinguishes cleanup removals, line additions and manual changes in bounded crops', () => {
    const baseline = { ...source, pixels: new Uint8Array(6) };
    const automatic = { ...source, pixels: Uint8Array.from([0, 1, 1, 1, 1, 1]) };
    const edited = { ...source, pixels: Uint8Array.from([0, 1, 1, 2, 1, 1]) };
    const rgba = renderPreviewRegion(edited, { x: 0, y: 0, width: 3, height: 2 }, 3, 2, { changes: true, baseline, automaticImage: automatic, changeKinds: Uint8Array.from([0, 1, 3, 2, 2, 3]) });
    expect([...rgba.slice(4, 8)]).toEqual([235, 93, 186, 255]);
    expect([...rgba.slice(8, 12)]).toEqual([126, 234, 124, 255]);
    expect([...rgba.slice(12, 16)]).toEqual([70, 205, 236, 255]);
  });
  it('rejects an accidental full-resolution RGBA allocation', () => {
    expect(() => renderPreviewRegion(source, { x: 0, y: 0, width: 3, height: 2 }, 6000, 5472)).toThrow('bounded pixel budget');
  });
});
