import { MAX_COLORS, type IndexedRaster, type Palette, type RasterInput } from './types';

export const MAX_RASTER_PIXELS = 100_000_000;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64Values = new Int16Array(128).fill(-1);
for (let i = 0; i < alphabet.length; i++) base64Values[alphabet.charCodeAt(i)] = i;

function pixelCount(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_RASTER_PIXELS) throw new Error('Raster dimensions must be positive integers with at most 100 million pixels.');
  return width * height;
}

/** Browser/Node portable base64 with bounded intermediate strings. */
export function encodeRaster(width: number, height: number, pixels: Uint8Array): IndexedRaster {
  if (pixels.length !== pixelCount(width, height)) throw new Error('Raster dimensions and pixel data do not match.');
  const chunks: string[] = [];
  let chunk = '';
  for (let i = 0; i < pixels.length; i += 3) {
    const a = pixels[i], b = pixels[i + 1] ?? 0, c = pixels[i + 2] ?? 0;
    chunk += alphabet[a >>> 2] + alphabet[((a & 3) << 4) | (b >>> 4)] + (i + 1 < pixels.length ? alphabet[((b & 15) << 2) | (c >>> 6)] : '=') + (i + 2 < pixels.length ? alphabet[c & 63] : '=');
    if (chunk.length >= 32768) { chunks.push(chunk); chunk = ''; }
  }
  if (chunk) chunks.push(chunk);
  return { width, height, pixelsBase64: chunks.join('') };
}

/** Strictly decode canonical base64; malformed or oversized payloads fail before allocation. */
export function decodeRaster(raster: IndexedRaster): Uint8Array {
  const count = pixelCount(raster.width, raster.height), text = raster.pixelsBase64;
  if (typeof text !== 'string' || text.length !== Math.ceil(count / 3) * 4) throw new Error('Raster base64 length does not match its dimensions.');
  const pixels = new Uint8Array(count);
  for (let i = 0, p = 0; i < text.length; i += 4) {
    const tail = count - p, a = base64Values[text.charCodeAt(i)] ?? -1, b = base64Values[text.charCodeAt(i + 1)] ?? -1;
    const c = tail > 1 ? base64Values[text.charCodeAt(i + 2)] ?? -1 : 0, d = tail > 2 ? base64Values[text.charCodeAt(i + 3)] ?? -1 : 0;
    if (a < 0 || b < 0 || c < 0 || d < 0 || (tail === 1 && (text[i + 2] !== '=' || (b & 15) !== 0)) || (tail <= 2 && text[i + 3] !== '=') || (tail === 2 && (c & 3) !== 0)) throw new Error('Raster pixels must use valid canonical base64.');
    pixels[p++] = (a << 2) | (b >>> 4);
    if (tail > 1) pixels[p++] = (b << 4) | (c >>> 2);
    if (tail > 2) pixels[p++] = (c << 6) | d;
  }
  return pixels;
}

export function validateRasterPalette(raster: IndexedRaster, palette: Palette): void {
  for (const index of decodeRaster(raster)) if (index >= palette.entries.length) throw new Error(`Raster color ${index} is outside the palette; merge used colors before removing them.`);
}

export function remapRaster(raster: IndexedRaster, mapping: number[]): IndexedRaster {
  const pixels = decodeRaster(raster);
  for (let i = 0; i < pixels.length; i++) {
    const next = mapping[pixels[i]];
    if (!Number.isInteger(next) || next < 0 || next > 255) throw new Error('Provide a valid target color for every raster color.');
    pixels[i] = next;
  }
  return encodeRaster(raster.width, raster.height, pixels);
}

type RGB = [number, number, number];
interface ColorSample { rgb: RGB; count: number; key: number }
const pack = (rgb: RGB): number => (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
const unpack = (key: number): RGB => [key >>> 16, (key >>> 8) & 255, key & 255];
const binOf = (key: number): number => ((key >>> 19) << 10) | (((key >>> 11) & 31) << 5) | ((key >>> 3) & 31);

function sourceColor(input: RasterInput, pixel: number): number {
  const p = pixel * input.channels;
  if (input.channels === 1) return input.data[p] * 0x10101;
  if (input.channels === 3 || input.data[p + 3] === 255) return (input.data[p] << 16) | (input.data[p + 1] << 8) | input.data[p + 2];
  const alpha = input.data[p + 3];
  const r = Math.round((input.data[p] * alpha + 255 * (255 - alpha)) / 255);
  const g = Math.round((input.data[p + 1] * alpha + 255 * (255 - alpha)) / 255);
  const b = Math.round((input.data[p + 2] * alpha + 255 * (255 - alpha)) / 255);
  return (r << 16) | (g << 8) | b;
}

function quantize(samples: ColorSample[], maxColors: number): RGB[] {
  const box = (colors: ColorSample[]) => {
    const lo = [255, 255, 255], hi = [0, 0, 0]; let weight = 0;
    for (const color of colors) { weight += color.count; for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], color.rgb[c]); hi[c] = Math.max(hi[c], color.rgb[c]); } }
    const spans = hi.map((value, c) => value - lo[c]);
    const axis = spans.indexOf(Math.max(...spans));
    return { colors, weight, axis, score: colors.length > 1 ? spans[axis] ** 2 * weight : -1 };
  };
  const boxes = [box(samples)];
  while (boxes.length < maxColors) {
    let selected = 0;
    for (let i = 1; i < boxes.length; i++) if (boxes[i].score > boxes[selected].score) selected = i;
    const current = boxes[selected]; if (current.score < 0) break;
    current.colors.sort((a, b) => a.rgb[current.axis] - b.rgb[current.axis] || a.key - b.key);
    let weight = 0, split = 0;
    while (split < current.colors.length - 1 && weight < current.weight / 2) weight += current.colors[split++].count;
    boxes.splice(selected, 1, box(current.colors.slice(0, split)), box(current.colors.slice(split)));
  }
  const distinct = new Map<number, RGB>();
  for (const current of boxes) {
    const rgb: RGB = [0, 0, 0];
    for (const color of current.colors) for (let c = 0; c < 3; c++) rgb[c] += color.rgb[c] * color.count;
    for (let c = 0; c < 3; c++) rgb[c] = Math.round(rgb[c] / current.weight);
    distinct.set(pack(rgb), rgb);
  }
  return [...distinct.values()];
}

/** Preserve decoded RGB colors by default; quantize only to an explicitly selected limit. */
export function importColorImage(input: RasterInput, colorLimit: number | 'preserve' = 'preserve'): { raster: IndexedRaster; palette: Palette; sourceColorCount: number; quantized: boolean } {
  const count = pixelCount(input.width, input.height);
  if (![1, 3, 4].includes(input.channels) || !(input.data instanceof Uint8Array) || input.data.length !== count * input.channels) throw new Error('Raster dimensions, channels and pixel data do not match.');
  if (colorLimit !== 'preserve' && (!Number.isInteger(colorLimit) || colorLimit < 1 || colorLimit > MAX_COLORS)) throw new Error(`Choose between 1 and ${MAX_COLORS} image colors, or keep original colors.`);
  const maxColors = colorLimit === 'preserve' ? MAX_COLORS : colorLimit;
  // Exact RGB membership is a 2 MB bitset, and the fallback histogram has 32K
  // bins. Even photographs cannot create millions of JS objects or vector nodes.
  const seen = new Uint8Array(1 << 21), bins = new Uint32Array(32768), sums = new Float64Array(32768 * 3);
  let exact: Map<number, number> | undefined = new Map(), sourceColorCount = 0;
  for (let p = 0; p < count; p++) {
    const key = sourceColor(input, p), byte = key >>> 3, bit = 1 << (key & 7), bin = binOf(key);
    if (!(seen[byte] & bit)) { seen[byte] |= bit; sourceColorCount++; }
    if (exact) { exact.set(key, (exact.get(key) ?? 0) + 1); if (exact.size > 32768) exact = undefined; }
    bins[bin]++; sums[bin * 3] += key >>> 16; sums[bin * 3 + 1] += (key >>> 8) & 255; sums[bin * 3 + 2] += key & 255;
  }
  if (colorLimit === 'preserve' && sourceColorCount > MAX_COLORS) throw new Error(`This image has ${sourceColorCount.toLocaleString('en-US')} colors. Indexed output supports up to ${MAX_COLORS}. Select Reduce colors and choose a limit, or upload an image with ${MAX_COLORS} colors or fewer.`);
  const quantized = sourceColorCount > maxColors;
  let colors: RGB[];
  if (!quantized) colors = [...exact!.keys()].map(unpack);
  else {
    const samples: ColorSample[] = exact ? [...exact].map(([key, n]) => ({ rgb: unpack(key), count: n, key })) : [];
    if (!exact) for (let bin = 0; bin < bins.length; bin++) if (bins[bin]) samples.push({ rgb: [sums[bin * 3] / bins[bin], sums[bin * 3 + 1] / bins[bin], sums[bin * 3 + 2] / bins[bin]], count: bins[bin], key: bin });
    colors = quantize(samples, maxColors);
  }
  const nearest = (rgb: RGB): number => {
    let best = 0, distance = Infinity;
    for (let c = 0; c < colors.length; c++) { const candidate = (rgb[0] - colors[c][0]) ** 2 + (rgb[1] - colors[c][1]) ** 2 + (rgb[2] - colors[c][2]) ** 2; if (candidate < distance) { best = c; distance = candidate; } }
    return best;
  };
  const exactMapping = exact ? new Map([...exact.keys()].map(key => [key, nearest(unpack(key))])) : undefined;
  const binMapping = new Uint8Array(32768);
  if (!exact) for (let bin = 0; bin < bins.length; bin++) if (bins[bin]) binMapping[bin] = nearest([sums[bin * 3] / bins[bin], sums[bin * 3 + 1] / bins[bin], sums[bin * 3 + 2] / bins[bin]]);
  const pixels = new Uint8Array(count), used = new Uint32Array(colors.length);
  for (let p = 0; p < count; p++) { const key = sourceColor(input, p), index = exactMapping ? exactMapping.get(key)! : binMapping[binOf(key)]; pixels[p] = index; used[index]++; }
  // Ground is the dominant source color, with RGB order as a stable tie-break.
  const order = colors.map((_, i) => i).filter(i => used[i]).sort((a, b) => used[b] - used[a] || pack(colors[a]) - pack(colors[b]));
  const mapping = new Uint8Array(colors.length); order.forEach((old, i) => { mapping[old] = i; });
  const palette: Palette = { entries: order.map((old, index) => ({ index, name: index === 0 ? 'Ground' : `Color ${index}`, displayRgb: [...colors[old]] as RGB, exportRgb: [...colors[old]] as RGB })) };
  for (let p = 0; p < count; p++) pixels[p] = mapping[pixels[p]];
  return { raster: encodeRaster(input.width, input.height, pixels), palette, sourceColorCount, quantized };
}
