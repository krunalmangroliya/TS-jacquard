import type { MachineProfile, Palette } from './types';
import { MAX_COLORS } from './types';

export function validateGrid(grid: Uint8Array, width: number, height: number, palette: Palette): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 40_000_000 || grid.length !== width * height) throw new Error('Invalid grid dimensions or pixel count');
  if (palette.entries.length < 1 || palette.entries.length > MAX_COLORS || palette.entries.some((e, i) => e.index !== i || e.exportRgb.length !== 3 || e.exportRgb.some(c => !Number.isInteger(c) || c < 0 || c > 255))) throw new Error(`Invalid palette: use 1–${MAX_COLORS} contiguous colors`);
  for (const value of grid) if (value >= palette.entries.length) throw new Error(`Pixel index ${value} is not in the palette`);
}
/** Uncompressed 8-bit Windows BMP. Pixel values are palette indices, never RGB quantization. */
export function encodeBmp(grid: Uint8Array, width: number, height: number, palette: Palette, profile: Pick<MachineProfile, 'epi' | 'ppi'>): Uint8Array {
  validateGrid(grid, width, height, palette);
  if (![profile.epi, profile.ppi].every(n => Number.isFinite(n) && n > 0 && n / 0.0254 <= 0x7fffffff)) throw new Error('Invalid output density');
  const stride = Math.ceil(width / 4) * 4;
  const offset = 14 + 40 + 256 * 4;
  const bytes = new Uint8Array(offset + stride * height), view = new DataView(bytes.buffer);
  bytes[0] = 0x42; bytes[1] = 0x4d;
  view.setUint32(2, bytes.length, true); view.setUint32(10, offset, true);
  view.setUint32(14, 40, true); view.setInt32(18, width, true); view.setInt32(22, height, true);
  view.setUint16(26, 1, true); view.setUint16(28, 8, true);
  view.setUint32(34, stride * height, true);
  view.setInt32(38, Math.round(profile.epi / 0.0254), true); view.setInt32(42, Math.round(profile.ppi / 0.0254), true);
  view.setUint32(46, 256, true);
  for (const entry of palette.entries) bytes.set([entry.exportRgb[2], entry.exportRgb[1], entry.exportRgb[0], 0], 54 + 4 * entry.index);
  for (let row = 0; row < height; row++) bytes.set(grid.subarray(row * width, (row + 1) * width), offset + (height - 1 - row) * stride);
  return bytes;
}
