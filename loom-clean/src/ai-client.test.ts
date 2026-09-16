import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeWithAi } from './ai-client';
import type { AiResult } from './ai-types';
import type { CleanupOptions, IndexedImage, Progress } from './types';

type Request = { image: IndexedImage; options: CleanupOptions };
type Reply = { progress?: Progress; result?: AiResult; error?: string };

/** Delivers queued messages even after terminate, as a defensive lifecycle check. */
class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: MessageEvent<Reply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  received: Request | undefined;
  terminate = vi.fn();
  postMessage = vi.fn((request: Request, transfer?: Transferable[] | StructuredSerializeOptions) => {
    this.received = structuredClone(request, Array.isArray(transfer) ? { transfer } : transfer);
  });
  constructor(_url: URL, _options: WorkerOptions) { MockWorker.instances.push(this); }
  reply(data: Reply) { this.onmessage?.({ data } as MessageEvent<Reply>); }
  fail(message: string) { this.onerror?.({ message } as ErrorEvent); }
}

function fixture(): Request {
  return {
    image: { width: 2, height: 2, pixels: Uint8Array.from([0, 1, 1, 0]), palette: [[20, 35, 110], [231, 200, 65]] },
    options: { width: 2, height: 2, read: 96, pick: 52, strength: 'balanced', flattenTexture: true, outlineColor: 0, protectedColors: [1], repeatX: false, repeatY: false },
  };
}

function result(image: IndexedImage): AiResult {
  return {
    image: structuredClone(image), changes: new Uint8Array(4), warnings: [],
    stats: { addedPixels: 0, removedPixels: 0, patchesScanned: 1, eligiblePatches: 1, candidatePixels: 4, scannedPixels: 4, totalPixels: 4, elapsedMs: 10, provider: 'test', modelName: 'test' },
  };
}

describe('AI worker client lifecycle', () => {
  beforeEach(() => { MockWorker.instances = []; vi.stubGlobal('Worker', MockWorker); });
  afterEach(() => vi.unstubAllGlobals());

  it('cancels once and ignores queued progress, completion and failure after cancellation', async () => {
    const { image, options } = fixture(), onProgress = vi.fn();
    const job = analyzeWithAi(image, options, onProgress), worker = MockWorker.instances[0];
    worker.reply({ progress: { stage: 'Inspecting', percent: 25 } });
    const rejected = expect(job.promise).rejects.toThrow('AI analysis cancelled.');
    job.cancel();
    worker.reply({ result: result(image) });
    worker.reply({ progress: { stage: 'Finished', percent: 100 } });
    worker.fail('late worker error');
    job.cancel();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls).toEqual([[{ stage: 'Inspecting', percent: 25 }]]);
  });

  it('resolves a successful preview and releases its worker without later cancellation changing it', async () => {
    const { image, options } = fixture(), onProgress = vi.fn(), preview = result(image);
    const job = analyzeWithAi(image, options, onProgress), worker = MockWorker.instances[0];
    worker.reply({ progress: { stage: 'Preparing preview', percent: 94 } });
    worker.reply({ result: preview });
    await expect(job.promise).resolves.toBe(preview);
    job.cancel();
    worker.reply({ error: 'late failure' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith({ stage: 'Preparing preview', percent: 94 });
  });

  it.each(['WASM worker could not load', ''])('releases a failed worker and surfaces its error (%j)', async workerMessage => {
    const { image, options } = fixture();
    const job = analyzeWithAi(image, options), worker = MockWorker.instances[0];
    const rejected = expect(job.promise).rejects.toThrow(workerMessage || 'The local AI worker could not start.');
    worker.fail(workerMessage);
    await rejected;
    job.cancel();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects model or inference errors reported by the worker instead of resolving a preview', async () => {
    const { image, options } = fixture();
    const job = analyzeWithAi(image, options), worker = MockWorker.instances[0];
    const rejected = expect(job.promise).rejects.toThrow('Model fingerprint mismatch');
    worker.reply({ error: 'Model fingerprint mismatch' });
    worker.reply({ result: result(image) });
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('clones the request without transferring or exposing the source and undo buffers to worker mutations', async () => {
    const { image, options } = fixture();
    const undoImage = { ...image, pixels: image.pixels }, before = image.pixels.slice();
    const job = analyzeWithAi(image, options), worker = MockWorker.instances[0];
    expect(worker.postMessage.mock.calls[0]).toHaveLength(1);
    expect(image.pixels.buffer.byteLength).toBe(4);
    expect(worker.received!.image.pixels.buffer).not.toBe(image.pixels.buffer);
    worker.received!.image.pixels.fill(1);
    worker.received!.image.palette[0][0] = 255;
    worker.received!.options.protectedColors.length = 0;
    expect(image.pixels).toEqual(before);
    expect(undoImage.pixels).toEqual(before);
    expect(image.palette[0][0]).toBe(20);
    expect(options.protectedColors).toEqual([1]);
    worker.reply({ result: result(image) });
    await job.promise;
  });
});
