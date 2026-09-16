import { describe, expect, it } from 'vitest';
import { CLEANUP_MEDIA_TYPE, cleanupRequestBlob, decodeCleanupRequest, decodeCleanupResult, encodeCleanupRequest, encodeCleanupResult } from './cleanup-wire';
import type { CleanupOptions, CleanupResult, IndexedImage } from './types';

const source: IndexedImage = { width: 3, height: 2, palette: [[0, 0, 0], [255, 196, 0]], pixels: Uint8Array.from([0, 1, 0, 1, 1, 0]) };
const options: CleanupOptions = { width: 3, height: 2, read: 96, pick: 52, strength: 'balanced', flattenTexture: true, outlineColor: 0, protectedColors: [1], repeatX: false, repeatY: false };
describe('cleanup binary transport', () => {
  it('round-trips indexed pixels, palette and output recipe without color conversion', () => {
    const original = source.pixels.slice();
    const decoded = decodeCleanupRequest(encodeCleanupRequest(source, options));
    expect(decoded.source).toEqual(source);
    expect(decoded.options).toEqual(options);
    expect(source.pixels).toEqual(original);
  });
  it('handles byte views with a nonzero offset', () => {
    const packet = encodeCleanupRequest(source, options);
    const padded = new Uint8Array(packet.length + 17); padded.set(packet, 9);
    expect(decodeCleanupRequest(padded.subarray(9, 9 + packet.length)).source.pixels).toEqual(source.pixels);
  });
  it('streams the same browser packet from a small header and indexed-pixel Blob part', async () => {
    const blob = cleanupRequestBlob(source, options);
    expect(blob.type).toBe(CLEANUP_MEDIA_TYPE);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(encodeCleanupRequest(source, options));
    expect(decodeCleanupRequest(await blob.arrayBuffer()).source).toEqual(source);
  });
  it('round-trips separate result, baseline and category buffers', () => {
    const result: CleanupResult = { image: { ...source, pixels: Uint8Array.from([1, 1, 0, 1, 1, 1]) }, baseline: source.pixels, changes: Uint8Array.from([1, 0, 0, 0, 0, 3]), stats: { changedPixels: 2, specksRemoved: 1, gapsRepaired: 1, texturePixels: 0, repeatedPixels: 0, elapsedMs: 14.5, sourceColors: 2, linePaths: 1 }, warnings: ['Review the thin border.'] };
    expect(decodeCleanupResult(encodeCleanupResult(result))).toEqual(result);
  });
  it('rejects truncated, oversized-header, mismatched-kind and invalid-index packets', () => {
    const packet = encodeCleanupRequest(source, options);
    expect(() => decodeCleanupRequest(packet.slice(0, -1))).toThrow('truncated');
    const broken = packet.slice(); new DataView(broken.buffer).setUint32(4, 2 ** 31, true);
    expect(() => decodeCleanupRequest(broken)).toThrow('header length');
    expect(() => decodeCleanupResult(packet)).toThrow('result packet');
    const invalidPixel = packet.slice(); invalidPixel[invalidPixel.length - 1] = 2;
    expect(() => decodeCleanupRequest(invalidPixel)).toThrow('palette index');
  });
  it('rejects invalid source dimensions and recipe before sending', () => {
    expect(() => encodeCleanupRequest({ ...source, width: 8193 }, options)).toThrow('dimensions');
    expect(() => encodeCleanupRequest(source, { ...options, width: 8192, height: 8192 })).toThrow('dimensions');
    expect(() => encodeCleanupRequest(source, { ...options, protectedColors: [10] })).toThrow('palette selection');
  });
});
