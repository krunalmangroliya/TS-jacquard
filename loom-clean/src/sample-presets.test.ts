import { describe, expect, it } from 'vitest';
import { parseReadPick, rotateSource, sampleKey, suggestOutlineColor } from './sample-presets';
import type { SourceImage } from './types';

describe('local sample filename metadata', () => {
  it.each(['42482pallu (r96p52) SIZED FILE.bmp', '45842 daman (R96P52 COMPLETE.bmp', 'part[R 96 p 52].png'])('reads bracket-independent read and pick: %s', name => {
    expect(parseReadPick(name)).toEqual({ read: 96, pick: 52 });
  });
  it('never invents settings for plain source names or invalid notation', () => {
    expect(parseReadPick('42973pallu.png')).toBeNull();
    expect(parseReadPick('part R0P52.png')).toBeNull();
    expect(parseReadPick('part R96P6000.png')).toBeNull();
  });
  it('matches source and output identities despite copy suffixes and part spelling', () => {
    expect(sampleKey('42973patta.png')).toBe('42973-patto');
    expect(sampleKey('42973 patto copy.bmp(R200 p66) COMPLETE.bmp')).toBe('42973-patto');
    expect(sampleKey('42482pallu PSD FILE.png')).toBe('42482-pallu');
    expect(sampleKey('artwork.png')).toBeNull();
  });
});

describe('primary outline suggestion', () => {
  it('ignores a rare black dirt ink even when it is the darkest palette entry', () => {
    const pixels = new Uint8Array(10_000).fill(1);
    pixels[0] = 0; pixels[1] = 0; pixels.fill(2, 5000);
    expect(suggestOutlineColor({ width: 100, height: 100, pixels, palette: [[0, 0, 0], [0, 0, 128], [240, 215, 0]] })).toBe(1);
  });
  it('uses perceptual luminance to distinguish navy and green with equal RGB sums', () => {
    expect(suggestOutlineColor({ width: 2, height: 2, pixels: Uint8Array.from([0, 0, 1, 1]), palette: [[0, 128, 0], [0, 0, 128]] })).toBe(1);
  });
  it('ignores unused palette entries', () => {
    expect(suggestOutlineColor({ width: 2, height: 1, pixels: Uint8Array.from([1, 1]), palette: [[0, 0, 0], [240, 215, 0]] })).toBe(1);
  });
});

describe('explicit source orientation', () => {
  const source: SourceImage = { name: 'original.png', width: 2, height: 3, pixels: Uint8Array.from([0, 1, 2, 3, 4, 5]), palette: [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4], [5, 5, 5]], originalColors: 6, dpiX: 96, dpiY: 52 };
  it('rotates clockwise with matching dimensions and swapped pixel densities', () => {
    const result = rotateSource(source, 90);
    expect([...result.pixels]).toEqual([4, 2, 0, 5, 3, 1]);
    expect([result.width, result.height, result.dpiX, result.dpiY]).toEqual([3, 2, 52, 96]);
    expect(result.palette).toBe(source.palette);
    expect([...source.pixels]).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('supports both remaining orientations without interpolation or lost indices', () => {
    expect([...rotateSource(source, 180).pixels]).toEqual([5, 4, 3, 2, 1, 0]);
    expect([...rotateSource(source, 270).pixels]).toEqual([1, 3, 5, 0, 2, 4]);
    expect(rotateSource(source, 0)).toBe(source);
  });
  it('four clockwise turns restore original pixel order', () => {
    const rotated = rotateSource(rotateSource(rotateSource(rotateSource(source, 90), 90), 90), 90);
    expect(rotated.width).toBe(source.width);
    expect(rotated.height).toBe(source.height);
    expect([...rotated.pixels]).toEqual([...source.pixels]);
  });
});
