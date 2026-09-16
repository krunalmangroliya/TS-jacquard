import { MAX_OUTPUT_PIXELS, MAX_SIDE, MAX_SOURCE_PIXELS, type CleanupOptions, type CleanupResult, type CleanupStats, type IndexedImage, type RGB } from './types';

export const CLEANUP_MEDIA_TYPE = 'application/vnd.loom-cleanup';
export const MAX_CLEANUP_PACKET_BYTES = 48 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cleanup packet metadata.');
  return value as RecordValue;
}
function dimensions(value: RecordValue, limit: number): { width: number; height: number } {
  const { width, height } = value;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > limit) throw new Error('Cleanup packet dimensions exceed supported limits.');
  return { width, height };
}
function palette(value: unknown): RGB[] {
  if (!Array.isArray(value) || !value.length || value.length > 256 || value.some(color => !Array.isArray(color) || color.length !== 3 || color.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255))) throw new Error('Invalid cleanup packet palette.');
  return value as RGB[];
}
function options(value: unknown, colors: number): CleanupOptions {
  const data = record(value), grid = dimensions(data, MAX_OUTPUT_PIXELS);
  const index = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < colors;
  if (!['gentle', 'balanced', 'strong'].includes(String(data.strength)) || (data.outlineColor !== null && !index(data.outlineColor)) || !Array.isArray(data.protectedColors) || data.protectedColors.length > 256 || data.protectedColors.some(value => !index(value))) throw new Error('Invalid cleanup recipe or palette selection.');
  if (typeof data.flattenTexture !== 'boolean' || typeof data.repeatX !== 'boolean' || typeof data.repeatY !== 'boolean') throw new Error('Invalid cleanup recipe flags.');
  if (![data.read, data.pick].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10000)) throw new Error('Invalid cleanup read or pick.');
  return { ...grid, read: data.read as number, pick: data.pick as number, strength: data.strength as CleanupOptions['strength'], outlineColor: data.outlineColor as number | null, protectedColors: data.protectedColors as number[], flattenTexture: data.flattenTexture, repeatX: data.repeatX, repeatY: data.repeatY };
}
function packet(header: unknown, parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const meta = new TextEncoder().encode(JSON.stringify(header));
  const length = 8 + meta.length + parts.reduce((sum, part) => sum + part.length, 0);
  if (meta.length > MAX_HEADER_BYTES || length > MAX_CLEANUP_PACKET_BYTES) throw new Error('Cleanup packet is too large.');
  const bytes = new Uint8Array(length);
  bytes.set([76, 67, 76, 49]);
  new DataView(bytes.buffer).setUint32(4, meta.length, true);
  bytes.set(meta, 8);
  let offset = 8 + meta.length;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
function unpack(input: ArrayBuffer | Uint8Array): { header: RecordValue; payload: Uint8Array } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8 || bytes.length > MAX_CLEANUP_PACKET_BYTES || bytes[0] !== 76 || bytes[1] !== 67 || bytes[2] !== 76 || bytes[3] !== 49) throw new Error('Invalid cleanup packet signature or size.');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (length < 1 || length > MAX_HEADER_BYTES || 8 + length > bytes.length) throw new Error('Invalid cleanup packet header length.');
  let header;
  try { header = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + length)))); }
  catch { throw new Error('Invalid cleanup packet JSON.'); }
  if (header.version !== 1) throw new Error('Unsupported cleanup packet version.');
  return { header, payload: bytes.subarray(8 + length) };
}
function checkIndices(pixels: Uint8Array, colors: number) {
  for (const index of pixels) if (index >= colors) throw new Error('Cleanup packet contains an invalid palette index.');
}

function requestHeader(source: IndexedImage, settings: CleanupOptions) {
  dimensions(source as unknown as RecordValue, MAX_SOURCE_PIXELS);
  palette(source.palette); options(settings, source.palette.length);
  if (source.pixels.length !== source.width * source.height) throw new Error('Cleanup source pixels do not match their dimensions.');
  return { version: 1, kind: 'request', source: { width: source.width, height: source.height, palette: source.palette }, options: settings };
}
export function encodeCleanupRequest(source: IndexedImage, settings: CleanupOptions): Uint8Array<ArrayBuffer> {
  return packet(requestHeader(source, settings), [source.pixels]);
}
/** Browser upload avoids assembling a second full-size contiguous pixel buffer. */
export function cleanupRequestBlob(source: IndexedImage, settings: CleanupOptions): Blob {
  const header = packet(requestHeader(source, settings), []);
  if (header.length + source.pixels.length > MAX_CLEANUP_PACKET_BYTES) throw new Error('Cleanup packet is too large.');
  const pixels = source.pixels.buffer instanceof ArrayBuffer
    ? new Uint8Array(source.pixels.buffer, source.pixels.byteOffset, source.pixels.byteLength)
    : new Uint8Array(source.pixels);
  return new Blob([header, pixels], { type: CLEANUP_MEDIA_TYPE });
}
export function decodeCleanupRequest(bytes: ArrayBuffer | Uint8Array): { source: IndexedImage; options: CleanupOptions } {
  const { header, payload } = unpack(bytes);
  if (header.kind !== 'request') throw new Error('Expected a cleanup request packet.');
  const description = record(header.source), size = dimensions(description, MAX_SOURCE_PIXELS), colors = palette(description.palette);
  if (payload.length !== size.width * size.height) throw new Error('Cleanup request pixels are truncated or have extra data.');
  checkIndices(payload, colors.length);
  return { source: { ...size, palette: colors, pixels: payload }, options: options(header.options, colors.length) };
}
export function encodeCleanupResult(result: CleanupResult): Uint8Array<ArrayBuffer> {
  dimensions(result.image as unknown as RecordValue, MAX_OUTPUT_PIXELS);
  const n = result.image.width * result.image.height;
  if ([result.image.pixels, result.baseline, result.changes].some(part => part.length !== n)) throw new Error('Cleanup result buffers do not match their dimensions.');
  return packet({ version: 1, kind: 'result', image: { width: result.image.width, height: result.image.height, palette: result.image.palette }, stats: result.stats, warnings: result.warnings }, [result.image.pixels, result.baseline, result.changes]);
}
export function decodeCleanupResult(bytes: ArrayBuffer | Uint8Array): CleanupResult {
  const { header, payload } = unpack(bytes);
  if (header.kind !== 'result') throw new Error('Expected a cleanup result packet.');
  const description = record(header.image), size = dimensions(description, MAX_OUTPUT_PIXELS), colors = palette(description.palette);
  const n = size.width * size.height;
  if (payload.length !== n * 3) throw new Error('Cleanup result buffers are truncated or have extra data.');
  const pixels = payload.subarray(0, n), baseline = payload.subarray(n, n * 2), changes = payload.subarray(n * 2);
  checkIndices(pixels, colors.length); checkIndices(baseline, colors.length);
  for (const kind of changes) if (kind > 3) throw new Error('Invalid cleanup change category.');
  const stats = record(header.stats);
  for (const key of ['changedPixels', 'specksRemoved', 'gapsRepaired', 'texturePixels', 'repeatedPixels', 'elapsedMs', 'sourceColors']) if (typeof stats[key] !== 'number' || !Number.isFinite(stats[key]) || stats[key] < 0) throw new Error('Invalid cleanup statistics.');
  if (!Array.isArray(header.warnings) || header.warnings.some(value => typeof value !== 'string')) throw new Error('Invalid cleanup review notes.');
  return { image: { ...size, palette: colors, pixels }, baseline, changes, stats: stats as unknown as CleanupStats, warnings: header.warnings as string[] };
}
