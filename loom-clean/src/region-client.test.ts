import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRegions } from './region-client';
import type { CleanupOptions, IndexedImage } from './types';

class WorkerStub {
  static current: WorkerStub;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  request?: { image: IndexedImage; options: CleanupOptions };
  terminate = vi.fn();
  constructor() { WorkerStub.current = this; }
  postMessage(request: { image: IndexedImage; options: CleanupOptions }, transfer?: Transferable[]) { this.request = structuredClone(request, { transfer }); }
}
const source: IndexedImage = { width: 2, height: 2, pixels: new Uint8Array([0, 1, 1, 0]), palette: [[0, 0, 128], [200, 160, 0]] };
const options: CleanupOptions = { width: 2, height: 2, read: 96, pick: 52, strength: 'balanced', flattenTexture: true, outlineColor: 0, protectedColors: [], repeatX: false, repeatY: false };
describe('region review worker lifetime', () => {
  beforeEach(() => vi.stubGlobal('Worker', WorkerStub));
  afterEach(() => vi.unstubAllGlobals());
  it('cancels without detaching the current canvas and ignores late results', async () => {
    const input = structuredClone(source), progress = vi.fn();
    const job = analyzeRegions(input, options, progress), worker = WorkerStub.current;
    worker.request!.image.pixels.fill(0);
    expect(input.pixels).toEqual(source.pixels);
    expect(input.pixels.buffer.byteLength).toBe(4);
    const rejected = expect(job.promise).rejects.toThrow('cancelled');
    job.cancel();
    worker.onmessage?.({ data: { result: { proposals: [], scannedPixels: 4, totalPixels: 4, elapsedMs: 1 } } } as MessageEvent);
    worker.onmessage?.({ data: { progress: { stage: 'late', percent: 100 } } } as MessageEvent);
    await rejected;
    expect(progress).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('returns proposal buffers as a separate result and releases its worker', async () => {
    const job = analyzeRegions(source, options, vi.fn()), worker = WorkerStub.current;
    const result = { proposals: [], scannedPixels: 4, totalPixels: 4, elapsedMs: 1 };
    worker.onmessage?.({ data: { result } } as MessageEvent);
    await expect(job.promise).resolves.toBe(result);
    job.cancel();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('surfaces analysis errors without returning a partial proposal', async () => {
    const job = analyzeRegions(source, options, vi.fn()), worker = WorkerStub.current;
    const rejected = expect(job.promise).rejects.toThrow('Invalid pixel');
    worker.onmessage?.({ data: { error: 'Invalid pixel' } } as MessageEvent);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
