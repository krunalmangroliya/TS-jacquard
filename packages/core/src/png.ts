import { validateGrid } from './bmp';
import type { Palette } from './types';

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[i] = c >>> 0; }
function crc(bytes: Uint8Array): number { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(name: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length); for (let i = 0; i < 4; i++) bytes[4 + i] = name.charCodeAt(i);
  bytes.set(data, 8); view.setUint32(8 + data.length, crc(bytes.subarray(4, 8 + data.length))); return bytes;
}
/** Portable deterministic PNG encoder: stored DEFLATE blocks avoid platform compressor differences. */
export function encodePng(grid: Uint8Array, width: number, height: number, palette: Palette): Uint8Array {
  validateGrid(grid, width, height, palette);
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(grid.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const blocks = Math.ceil(raw.length / 65535), zlib = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  zlib.set([0x78, 0x01]); let at = 2;
  for (let start = 0; start < raw.length; start += 65535) {
    const n = Math.min(65535, raw.length - start); zlib[at++] = start + n === raw.length ? 1 : 0;
    zlib[at++] = n & 255; zlib[at++] = n >>> 8; zlib[at++] = (~n) & 255; zlib[at++] = ((~n) >>> 8) & 255;
    zlib.set(raw.subarray(start, start + n), at); at += n;
  }
  let a = 1, b = 0; for (const byte of raw) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  new DataView(zlib.buffer).setUint32(at, ((b << 16) | a) >>> 0);
  const ihdr = new Uint8Array(13), iv = new DataView(ihdr.buffer); iv.setUint32(0, width); iv.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 3;
  const plte = new Uint8Array(palette.entries.length * 3); for (const entry of palette.entries) plte.set(entry.exportRgb, entry.index * 3);
  const pieces = [new Uint8Array([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', zlib), chunk('IEND', new Uint8Array())];
  const result = new Uint8Array(pieces.reduce((sum, p) => sum + p.length, 0)); at = 0; for (const piece of pieces) { result.set(piece, at); at += piece.length; } return result;
}
