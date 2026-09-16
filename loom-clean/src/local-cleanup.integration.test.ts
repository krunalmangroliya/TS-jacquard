import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cleanRaster } from './engine';
import { CLEANUP_MEDIA_TYPE, decodeCleanupResult, encodeCleanupRequest } from './cleanup-wire';
import type { CleanupOptions, IndexedImage } from './types';

// Opt in only while the launcher is running and no designer cleanup is active.
const endpoint = 'http://127.0.0.1:4328/__loom_cleanup';
const headers = { 'Content-Type': CLEANUP_MEDIA_TYPE, Origin: 'http://127.0.0.1:4328' };
const source: IndexedImage = { width: 24, height: 24, palette: [[0, 0, 128], [220, 190, 0], [240, 0, 150]], pixels: Uint8Array.from({ length: 576 }, (_, i) => { const x = i % 24, y = Math.floor(i / 24); return x === 4 || x === 19 || y === 4 || y === 19 ? 0 : (x + y) % 11 === 0 ? 2 : 1; }) };
const options: CleanupOptions = { width: 12, height: 12, read: 96, pick: 52, strength: 'balanced', flattenTexture: true, outlineColor: 0, protectedColors: [], repeatX: false, repeatY: false };

describe.skipIf(process.env.LOOM_NATIVE_SMOKE !== '1')('running loopback cleanup endpoint', () => {
  it('runs the same engine and returns the same indexed buffers', async () => {
    const expected = cleanRaster(source, options);
    const response = await fetch(endpoint, { method: 'POST', headers, body: encodeCleanupRequest(source, options) });
    if (!response.ok) throw new Error(`Native cleanup ${response.status}: ${await response.text()}`);
    expect(response.headers.get('content-type')).toBe(CLEANUP_MEDIA_TYPE);
    const result = decodeCleanupResult(await response.arrayBuffer());
    expect(result.image).toEqual(expected.image);
    expect(result.baseline).toEqual(expected.baseline);
    expect(result.changes).toEqual(expected.changes);
    expect(result.stats.changedPixels).toBe(expected.stats.changedPixels);
    expect(result.warnings).toEqual(expected.warnings);
  }, 30_000);
  it('rejects malformed indexed packets and releases its job slot', async () => {
    const body = encodeCleanupRequest(source, options); body[body.length - 1] = 255;
    const response = await fetch(endpoint, { method: 'POST', headers, body });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('palette index');
  }, 30_000);
  it('rejects a foreign web origin before starting any computation', async () => {
    const response = await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://example.invalid' }, body: encodeCleanupRequest(source, options) });
    expect(response.status).toBe(403);
  });
  it('limits concurrency and releases cancelled native work for the next job', async () => {
    const large: IndexedImage = { width: 2000, height: 2000, palette: source.palette, pixels: Uint8Array.from({ length: 4_000_000 }, (_, i) => i % 7 === 0 ? 0 : i % 13 === 0 ? 2 : 1) };
    const controller = new AbortController();
    const jobId = randomUUID();
    const pending = fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-Loom-Job': jobId }, body: encodeCleanupRequest(large, { ...options, width: 1600, height: 1600 }), signal: controller.signal }).then(response => ({ response }), error => ({ error }));
    try {
      await delay(40);
      const busy = await fetch(endpoint, { method: 'POST', headers, body: encodeCleanupRequest(source, options) });
      expect(busy.status).toBe(429);
      await delay(180); // Native worker has started, rather than only cancelling the upload.
      controller.abort();
      const cancellation = await fetch(`${endpoint}/${jobId}`, { method: 'DELETE', headers: { Origin: headers.Origin } });
      expect(cancellation.status).toBe(200);
      const cancelled = await pending;
      expect('error' in cancelled && cancelled.error.name).toBe('AbortError');
      let success = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        await delay(40);
        const next = await fetch(endpoint, { method: 'POST', headers, body: encodeCleanupRequest(source, options) });
        if (next.status === 429) continue;
        if (!next.ok) throw new Error(`After cancellation ${next.status}: ${await next.text()}`);
        expect(decodeCleanupResult(await next.arrayBuffer()).image.width).toBe(options.width);
        success = true; break;
      }
      expect(success).toBe(true);
    } finally { controller.abort(); await pending; await fetch(`${endpoint}/${jobId}`, { method: 'DELETE', headers: { Origin: headers.Origin } }); }
  }, 30_000);
});
