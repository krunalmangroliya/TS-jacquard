import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { encodeBmp } from './bmp';
import { encodePng } from './png';
import type { Palette } from './types';
const palette: Palette = { entries: [[255,255,255], [255,0,0], [0,0,0]].map((rgb, index) => ({ index, name: String(index), displayRgb: rgb as [number,number,number], exportRgb: rgb as [number,number,number] })) };
describe('indexed output interoperability', () => {
  it.each([7, 256])('preserves all %i palette colors in 8-bit BMP pixel rows and RGB table', count => {
    const fullPalette: Palette = { entries: Array.from({ length: count }, (_, index) => ({ index, name: String(index), displayRgb: [index, 255 - index, (index * 7) % 256], exportRgb: [index, 255 - index, (index * 7) % 256] })) };
    const width = count + 1, height = 3, grid = Uint8Array.from({ length: width * height }, (_, p) => (p * 17) % count);
    const bytes = encodeBmp(grid, width, height, fullPalette, { epi: 96, ppi: 52 }), view = new DataView(bytes.buffer);
    expect(view.getUint16(28, true)).toBe(8); expect(view.getUint32(30, true)).toBe(0);
    expect(view.getUint32(46, true)).toBe(256);
    const offset = view.getUint32(10, true), stride = Math.ceil(width / 4) * 4;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = bytes[offset + (height - 1 - y) * stride + x], table = 54 + index * 4;
      expect(index).toBe(grid[y * width + x]);
      expect([bytes[table + 2], bytes[table + 1], bytes[table]]).toEqual(fullPalette.entries[index].exportRgb);
    }
    expect(new Set(grid).size).toBe(count);
  });
  it('writes hand-verified BMP headers, palette bytes and bottom-up rows', () => {
    const bytes = encodeBmp(new Uint8Array([0,0,1,1,0,2,2,1,2,2,2,2]), 4, 3, palette, { epi: 60, ppi: 48 });
    const v = new DataView(bytes.buffer);
    expect([...bytes.slice(0,2)]).toEqual([66,77]); expect(v.getUint32(10,true)).toBe(1078);
    expect(v.getUint16(28,true)).toBe(8); expect(v.getUint32(34,true)).toBe(12);
    expect([...bytes.slice(54,66)]).toEqual([255,255,255,0,0,0,255,0,0,0,0,0]);
    expect([...bytes.slice(1078)]).toEqual([2,2,2,2,0,2,2,1,0,0,1,1]);
    expect(v.getUint32(38,true)).toBe(2362); expect(v.getUint32(42,true)).toBe(1890);
  });
  it('pads odd widths independently of row orientation', () => {
    const bytes = encodeBmp(new Uint8Array([0,1,2,2,1,0]),3,2,palette,{epi:60,ppi:48});
    expect([...bytes.slice(1078)]).toEqual([2,1,0,0,0,1,2,0]);
  });
  it('encodes actual indexed PNGs that an independent decoder reads exactly', () => {
    const grid = new Uint8Array([0,1,2,2,1,0]); const bytes = encodePng(grid,3,2,palette);
    expect(bytes[25]).toBe(3);
    const png = PNG.sync.read(Buffer.from(bytes)); expect(png.width).toBe(3); expect(png.height).toBe(2);
    expect([...png.data]).toEqual([...grid].flatMap(i => [...palette.entries[i].exportRgb,255]));
    expect(encodePng(grid,3,2,palette)).toEqual(bytes);
  });
  it.each([[256,255],[255,256],[508,258]])('round-trips every pixel across stored-DEFLATE block boundaries at %i×%i', (width, height) => {
    // Filter bytes are included in the DEFLATE payload: these cases end exactly at
    // 65535 bytes, cross it by one byte, and cross two boundaries mid-scanline.
    const grid = Uint8Array.from({ length: width * height }, (_, p) => ((p % width) * 7 + Math.floor(p / width) * 11 + Math.floor(p / 127)) % palette.entries.length);
    const bytes = encodePng(grid, width, height, palette);
    const decoded = PNG.sync.read(Buffer.from(bytes));
    const expected = Buffer.alloc(grid.length * 4);
    for (let p = 0; p < grid.length; p++) {
      const rgb = palette.entries[grid[p]].exportRgb;
      expected[p * 4] = rgb[0]; expected[p * 4 + 1] = rgb[1]; expected[p * 4 + 2] = rgb[2]; expected[p * 4 + 3] = 255;
    }
    expect(decoded.width).toBe(width); expect(decoded.height).toBe(height);
    expect(decoded.data.equals(expected)).toBe(true);
  });
});
