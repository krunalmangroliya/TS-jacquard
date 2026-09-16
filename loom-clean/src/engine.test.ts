import { describe, expect, it } from 'vitest';
import { cleanRaster } from './engine';
import type { CleanupOptions, IndexedImage } from './types';

const options = (width: number, height: number, extra: Partial<CleanupOptions> = {}): CleanupOptions => ({
  width, height, read: 96, pick: 52, strength: 'balanced', flattenTexture: false,
  outlineColor: null, protectedColors: [], repeatX: false, repeatY: false, ...extra,
});
const raster = (width: number, height: number): IndexedImage => ({
  width, height, pixels: new Uint8Array(width * height),
  palette: [[255, 230, 0], [0, 0, 128], [240, 0, 160]],
});
const ink = (im: IndexedImage, x: number, y: number, c = 1) => { im.pixels[y * im.width + x] = c; };

function lineSource(gap: 'sampling' | 'real'): IndexedImage {
  const im = raster(21, 15);
  for (let x = 4; x <= 16; x++) ink(im, x, 7);
  if (gap === 'sampling') {
    ink(im, 10, 7, 0);
    for (let x = 9; x <= 11; x++) ink(im, x, 6);
  } else {
    for (let x = 9; x <= 11; x++) ink(im, x, 7, 0);
  }
  return im;
}

describe('source-supported cleanup', () => {
  it('uses the exact center-nearest baseline and keeps dimensions and palette', () => {
    const im = raster(7, 5);
    for (let i = 0; i < im.pixels.length; i++) im.pixels[i] = i % 3;
    const out = cleanRaster(im, options(4, 3, { protectedColors: [0, 1, 2] }));
    const expected = new Uint8Array(12);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++)
      expected[y * 4 + x] = im.pixels[Math.floor((y + 0.5) * 5 / 3) * 7 + Math.floor((x + 0.5) * 7 / 4)];
    expect(out.baseline).toEqual(expected);
    expect(out.image.pixels).toEqual(expected);
    expect(out.image.palette).toEqual(im.palette);
    expect(out.image.width).toBe(4); expect(out.image.height).toBe(3);
  });

  it('removes a low-support isolated resampling speck', () => {
    const im = raster(15, 15);
    ink(im, 7, 7, 2);
    const out = cleanRaster(im, options(5, 5));
    expect(out.baseline[12]).toBe(2);
    expect(out.image.pixels[12]).toBe(0);
    expect(out.stats.specksRemoved).toBe(1);
    expect(out.stats.changedPixels).toBe(1);
  });

  it('keeps a compact intentional source dot despite low target-cell coverage', () => {
    const im = raster(15, 15);
    for (let y = 7; y <= 8; y++) for (let x = 7; x <= 8; x++) ink(im, x, y, 2);
    const out = cleanRaster(im, options(5, 5));
    expect(out.baseline[12]).toBe(2);
    expect(out.image.pixels[12]).toBe(2);
    expect(out.stats.changedPixels).toBe(0);
  });

  it('keeps a source-supported single-pixel intentional dot when no downscale is needed', () => {
    const im = raster(9, 9);
    ink(im, 4, 4, 2);
    const out = cleanRaster(im, options(9, 9, { strength: 'strong' }));
    expect(out.image.pixels).toEqual(im.pixels);
  });

  it('can clean stray outline ink without removing a genuine short source stroke', () => {
    const im = raster(21, 21);
    ink(im, 4, 4);
    for (let y = 10; y < 14; y++) ink(im, 13, y);
    const out = cleanRaster(im, options(7, 7, { outlineColor: 1 }));
    expect(out.image.pixels[1 * 7 + 1]).toBe(0);
    expect(out.image.pixels[3 * 7 + 4]).toBe(1);
    expect(out.image.pixels[4 * 7 + 4]).toBe(1);
  });

  it('repairs a one-pixel gap only when the original line is continuous', () => {
    const out = cleanRaster(lineSource('sampling'), options(7, 5, { outlineColor: 1 }));
    expect(out.baseline[2 * 7 + 3]).toBe(0);
    expect(out.image.pixels[2 * 7 + 3]).toBe(1);
    expect(out.stats.gapsRepaired).toBe(1);
    const trueGap = cleanRaster(lineSource('real'), options(7, 5, { outlineColor: 1 }));
    expect(trueGap.image.pixels[2 * 7 + 3]).toBe(0);
    expect(trueGap.stats.gapsRepaired).toBe(0);
  });

  it('does not bridge parallel outlines even with stray source ink between them', () => {
    const im = raster(21, 21);
    for (let y = 1; y < 20; y++) { ink(im, 7, y); ink(im, 13, y); }
    ink(im, 10, 9); ink(im, 10, 11);
    const out = cleanRaster(im, options(7, 7, { outlineColor: 1, strength: 'strong' }));
    for (let y = 0; y < 7; y++) expect(out.image.pixels[y * 7 + 3]).toBe(0);
    expect(out.stats.gapsRepaired).toBe(0);
  });

  it('keeps a competing source channel when outline endpoints connect around it', () => {
    const im = raster(21, 21);
    // Endpoints (7,7) and (13,13) are connected inside their source patch, by
    // going around the lower-left corner. The other diagonal stays connected
    // in background color. This route must not become a diagonal slash.
    for (let x = 5; x <= 7; x++) ink(im, x, 7);
    for (let y = 7; y <= 15; y++) ink(im, 5, y);
    for (let x = 5; x <= 13; x++) ink(im, x, 15);
    for (let y = 13; y <= 15; y++) ink(im, 13, y);
    // Nearby source ink raises coverage without crossing that background path.
    ink(im, 9, 9); ink(im, 9, 10);
    const out = cleanRaster(im, options(7, 7, { outlineColor: 1, strength: 'strong' }));
    expect(out.baseline[3 * 7 + 3]).toBe(0);
    expect(out.image.pixels[3 * 7 + 3]).toBe(0);
  });

  it('never removes or expands a protected color', () => {
    const im = raster(15, 15); ink(im, 7, 7, 2);
    for (const protectedColors of [[2], [0]]) {
      const out = cleanRaster(im, options(5, 5, { protectedColors }));
      expect(out.image.pixels).toEqual(out.baseline);
    }
    const line = cleanRaster(lineSource('sampling'), options(7, 5, { outlineColor: 1, protectedColors: [1] }));
    expect(line.image.pixels).toEqual(line.baseline);
  });

  it('treats repeat edges as connected without mirroring or copying motifs', () => {
    const im = raster(15, 15);
    ink(im, 1, 7, 2); ink(im, 13, 7, 2);
    const ordinary = cleanRaster(im, options(5, 5, { strength: 'gentle' }));
    const repeated = cleanRaster(im, options(5, 5, { strength: 'gentle', repeatX: true }));
    expect(ordinary.stats.changedPixels).toBe(2);
    expect(repeated.stats.changedPixels).toBe(0);
    expect(repeated.image.pixels[10]).toBe(2);
    expect(repeated.image.pixels[14]).toBe(2);
  });

  it('optionally flattens a dense stippled field but keeps isolated ornaments', () => {
    const im = raster(33, 33);
    for (let y = 2; y < 22; y += 2) for (let x = 2; x < 22; x += 2) ink(im, x, y, 2);
    for (let y = 27; y < 30; y++) for (let x = 27; x < 30; x++) ink(im, x, y, 2);
    const plain = cleanRaster(im, options(33, 33));
    const flattened = cleanRaster(im, options(33, 33, { flattenTexture: true }));
    expect(plain.stats.changedPixels).toBe(0);
    expect(flattened.stats.texturePixels).toBeGreaterThan(60);
    expect(flattened.image.pixels[28 * 33 + 28]).toBe(2);
    expect(flattened.image.palette).toEqual(im.palette);
  });

  it('preserves a ring center inside a mottled field even when its rim is not the outline', () => {
    const im = raster(33, 33);
    for (let y = 2; y < 30; y += 2) for (let x = 2; x < 30; x += 2) ink(im, x, y, 2);
    for (let y = 15; y <= 17; y++) for (let x = 15; x <= 17; x++) ink(im, x, y, 1);
    ink(im, 16, 16, 2);
    const out = cleanRaster(im, options(33, 33, { flattenTexture: true }));
    expect(out.image.pixels[16 * 33 + 16]).toBe(2);
    expect(out.stats.texturePixels).toBeGreaterThan(20);
  });

  it('does not repair line gaps when either axis is being enlarged', () => {
    const out = cleanRaster(lineSource('sampling'), options(7, 20, { outlineColor: 1 }));
    expect(out.stats.gapsRepaired).toBe(0);
    expect(out.warnings.some(w => w.includes('enlarges'))).toBe(true);
  });

  it('preserves high-resolution compact cells in structured crosshatching', () => {
    const im = raster(123, 123);
    // Each original pale rectangular cell occupies most of a final footprint;
    // its separation from its neighbors is an intentional connected mesh.
    for (let gy = 3; gy < 37; gy += 3) for (let gx = 3; gx < 37; gx += 3)
      for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 3; xx++) ink(im, gx * 3 + xx, gy * 3 + yy, 2);
    const out = cleanRaster(im, options(41, 41, { flattenTexture: true }));
    for (let gy = 3; gy < 37; gy += 3) for (let gx = 3; gx < 37; gx += 3)
      expect(out.image.pixels[gy * 41 + gx]).toBe(2);
  });

  it('keeps a solid small ornament even when it sits inside an active grain field', () => {
    const im = raster(33, 33);
    for (let y = 2; y < 30; y += 2) for (let x = 2; x < 30; x += 2) ink(im, x, y, 2);
    for (let y = 14; y < 18; y++) for (let x = 14; x < 18; x++) ink(im, x, y, 1);
    const out = cleanRaster(im, options(33, 33, { flattenTexture: true }));
    for (let y = 14; y < 18; y++) for (let x = 14; x < 18; x++) expect(out.image.pixels[y * 33 + x]).toBe(1);
    expect(out.stats.texturePixels).toBeGreaterThan(50);
  });

  it('keeps bounded source hatch cells which end exactly on an inspection-patch edge', () => {
    const im = raster(123, 246);
    for (let gy = 3; gy < 37; gy += 3) for (let gx = 3; gx < 37; gx += 4)
      for (let y = gy * 6; y < gy * 6 + 7; y++) for (let x = gx * 3; x < gx * 3 + 7; x++) ink(im, x, y, 2);
    const out = cleanRaster(im, options(41, 41, { flattenTexture: true }));
    for (let gy = 3; gy < 37; gy += 3) for (let gx = 3; gx < 37; gx += 4) {
      expect(out.image.pixels[gy * 41 + gx]).toBe(2);
      expect(out.image.pixels[gy * 41 + gx + 1]).toBe(2);
    }
  });

  it('keeps the center of a nested oval ornament with an annulus and second rim', () => {
    const rows = [
      'SSSSSSSSSSSSSSSSSSSSS', 'SSSSSSSSSSSSSSSSSSSSS', 'SSSSSSSSSSSSSSSSSSSSS',
      'SSSSSSYYYYYYYYYSSSSSS', 'SSSYYYYLLLLLLLYYYSSSS', 'SSSYYLLLLLLLLLLLYYSSS',
      'SSYYLLLLYYYYYLLLLYYSS', 'SSYYLLLYYYYYYLLLLYYSS', 'SSYYLLLLLYYYLLLLYYSSS',
      'SSSYYLLLLLLLLLLYYYSSS', 'SSSSYYYYYLLYYYYYSSSSS', 'SSSSSSSYYYYYYSSSSSSSS',
      'SSSSSSSSSSSSSSSSSSSSS',
    ];
    const im = raster(31, 23);
    for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++)
      ink(im, x + 5, y + 5, { S: 0, Y: 1, L: 2 }[rows[y][x]]!);
    const out = cleanRaster(im, options(31, 23, { flattenTexture: true }));
    for (let y = 11; y <= 13; y++) for (let x = 12; x <= 17; x++) {
      if (im.pixels[y * 31 + x] === 1) expect(out.image.pixels[y * 31 + x]).toBe(1);
    }
  });

  it('is deterministic, leaves source/options unchanged, and counts actual changes', () => {
    const im = lineSource('sampling'), original = im.pixels.slice();
    const opts = options(7, 5, { outlineColor: 1 });
    const before = JSON.stringify(opts);
    const first = cleanRaster(im, opts), second = cleanRaster(im, opts);
    expect(first.image.pixels).toEqual(second.image.pixels);
    expect(first.changes).toEqual(second.changes);
    expect(im.pixels).toEqual(original);
    expect(JSON.stringify(opts)).toBe(before);
    expect(first.stats.changedPixels).toBe(first.image.pixels.reduce((sum, c, i) => sum + Number(c !== first.baseline[i]), 0));
    first.image.palette[0][0] = 0;
    expect(im.palette[0][0]).toBe(255);
  });

  it('rejects unsupported dimensions and corrupt palette indices', () => {
    const im = raster(3, 3);
    expect(() => cleanRaster(im, options(0, 3))).toThrow(/dimensions/);
    expect(() => cleanRaster(im, options(8192, 8192))).toThrow(/limits/);
    expect(() => cleanRaster(im, options(3, 3, { protectedColors: [9] }))).toThrow(/palette/);
    expect(() => cleanRaster(im, options(3, 3, { read: Number.NaN }))).toThrow(/Read and pick/);
    expect(() => cleanRaster(im, options(3, 3, { pick: 0 }))).toThrow(/Read and pick/);
    im.pixels[0] = 5;
    expect(() => cleanRaster(im, options(3, 3))).toThrow(/palette index/);
  });
});
