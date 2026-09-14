import { describe, expect, it } from 'vitest';
import { prepareTraceInput, importPalette } from './input-preprocessing';
import { binarize, traceImage } from './trace';
import { traceParamsSchema, paletteSchema } from './schemas';
import { DEFAULT_PALETTE, type RasterInput } from './types';

describe('selected source artwork colors', () => {
  it('keeps black/white input and the existing threshold/invert trace exactly unchanged', () => {
    const data = new Uint8Array(32 * 32 * 4).fill(255);
    for (let y = 4; y < 28; y++) for (let x = 14; x < 18; x++) { const i = (y * 32 + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
    const input: RasterInput = { width: 32, height: 32, channels: 4, data }, copy = data.slice();
    expect(prepareTraceInput(input)).toBe(input);
    for (const params of [{ threshold: 'otsu' as const, invert: false }, { threshold: 150, invert: false }, { threshold: 130, invert: true }]) expect(traceImage(prepareTraceInput(input, 'black-white'), { ...params, gapClosePx: 0 })).toEqual(traceImage(input, { ...params, gapClosePx: 0 }));
    expect(data).toEqual(copy); expect(importPalette(DEFAULT_PALETTE).palette).toEqual(DEFAULT_PALETTE); expect(importPalette(DEFAULT_PALETTE).strokeColorIndex).toBe(5);
  });

  it('separates shaded gold ink from black texture and retains pale gold highlights', () => {
    const input: RasterInput = { width: 6, height: 1, channels: 3, data: Uint8Array.from([16,16,16, 32,20,5, 50,34,8, 208,176,80, 245,226,177, 164,132,46]) };
    const prepared = prepareTraceInput(input, 'black-gold');
    expect(prepared.channels).toBe(1); expect([...binarize(prepared).binary]).toEqual([0,0,0,1,1,1]);
    expect([...binarize(prepared, 'otsu', true).binary]).toEqual([1,1,1,0,0,0]);
  });

  it('treats transparent pixels as ground in gold mode without altering source RGBA', () => {
    const input: RasterInput = { width: 4, height: 1, channels: 4, data: Uint8Array.from([255,255,255,0, 0,0,0,0, 216,184,92,255, 216,184,92,128]) }, copy = input.data.slice();
    const prepared = prepareTraceInput(input, 'black-gold');
    expect(prepared.data[0]).toBe(255); expect(prepared.data[1]).toBe(255); expect(prepared.data[3]).toBeGreaterThan(prepared.data[2]); expect(input.data).toEqual(copy);
    expect(() => prepareTraceInput({ ...input, width: 8 }, 'black-gold')).toThrow(/dimensions/);
  });

  it('creates a dark-ground/gold palette without modifying workspace settings or exceeding six colors', () => {
    const before = structuredClone(DEFAULT_PALETTE), result = importPalette(DEFAULT_PALETTE, 'black-gold');
    expect(result.strokeColorIndex).toBe(1); expect(result.palette.entries[0].exportRgb).toEqual([0,0,0]); expect(result.palette.entries[1].exportRgb).toEqual([255,200,0]); expect(result.palette.entries).toHaveLength(6); expect(DEFAULT_PALETTE).toEqual(before);
    const smallest = importPalette({ entries: [DEFAULT_PALETTE.entries[0]] }, 'black-gold');
    expect(smallest.strokeColorIndex).toBe(1); expect(smallest.palette.entries).toHaveLength(2); expect(paletteSchema.parse(smallest.palette)).toEqual(smallest.palette);
  });

  it('persists the optional mode while accepting old trace settings', () => {
    const params = traceImage({ width: 8, height: 8, channels: 1, data: new Uint8Array(64).fill(255) }, { gapClosePx: 0 }).params;
    expect(traceParamsSchema.parse(params)).toEqual(params);
    expect(traceParamsSchema.parse({ ...params, inputMode: 'black-gold' }).inputMode).toBe('black-gold');
    expect(traceParamsSchema.safeParse({ ...params, inputMode: 'unknown' }).success).toBe(false);
  });
});
