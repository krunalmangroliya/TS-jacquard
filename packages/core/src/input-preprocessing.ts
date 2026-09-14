import type { Palette, RasterInput, TraceInputMode } from './types';

/** Convert selected source artwork to dark trace ink without changing its pixels.
 * Black/white deliberately keeps the existing luminance and alpha behavior.
 * Gold art uses bright ink on a dark ground; neutral highlights also belong to
 * the ink, so luminance separation preserves them instead of a narrow hue mask.
 */
export function prepareTraceInput(input: RasterInput, mode: TraceInputMode = 'black-white'): RasterInput {
  if (mode === 'black-white') return input;
  if (mode !== 'black-gold') throw new Error('Choose Black & White or Black & Gold artwork.');
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1 || ![1, 3, 4].includes(input.channels) || input.data.length !== input.width * input.height * input.channels) throw new Error('Raster dimensions and pixel data do not match.');
  const data = new Uint8Array(input.width * input.height);
  for (let i = 0; i < data.length; i++) {
    const j = i * input.channels;
    let luminance = input.channels === 1 ? input.data[j] : (2126 * input.data[j] + 7152 * input.data[j + 1] + 722 * input.data[j + 2]) / 10000;
    // Transparent pixels are dark ground in gold artwork, not bright trace ink.
    if (input.channels === 4) luminance *= input.data[j + 3] / 255;
    data[i] = 255 - Math.round(luminance);
  }
  return { width: input.width, height: input.height, channels: 1, data };
}

/** A separate starting palette belongs to this import, never workspace settings. */
export function importPalette(palette: Palette, mode: TraceInputMode = 'black-white'): { palette: Palette; strokeColorIndex: number } {
  const entries = palette.entries.map(entry => ({ ...entry, displayRgb: [...entry.displayRgb] as [number, number, number], exportRgb: [...entry.exportRgb] as [number, number, number] }));
  let strokeColorIndex = entries.find(entry => /outline|stroke/i.test(entry.name))?.index ?? entries.length - 1;
  if (mode === 'black-gold') {
    const preferred = entries.find(entry => entry.index > 0 && /gold|zari/i.test(entry.name)) ?? entries.find(entry => entry.index > 0 && /outline|stroke/i.test(entry.name)) ?? [...entries].reverse().find(entry => entry.index > 0);
    strokeColorIndex = preferred?.index ?? 1;
    entries[0] = { ...entries[0], displayRgb: [20, 20, 18], exportRgb: [0, 0, 0] };
    entries[strokeColorIndex] = { index: strokeColorIndex, name: preferred && /gold|zari/i.test(preferred.name) ? preferred.name : 'Gold stroke', displayRgb: [216, 184, 92], exportRgb: [255, 200, 0] };
  }
  return { palette: { entries }, strokeColorIndex };
}
