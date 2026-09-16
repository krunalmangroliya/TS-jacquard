import type { CleanupOptions, IndexedImage, Progress } from './types';
import type { RegionScanResult } from './region-types';

export function analyzeRegions(image: IndexedImage, options: CleanupOptions, onProgress: (progress: Progress) => void): { promise: Promise<RegionScanResult>; cancel: () => void } {
  const worker = new Worker(new URL('./region.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectJob: (reason: Error) => void = () => {};
  const promise = new Promise<RegionScanResult>((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = (event: MessageEvent<{ progress?: Progress; result?: RegionScanResult; error?: string }>) => {
      if (settled) return;
      if (event.data.progress) onProgress(event.data.progress);
      else if (event.data.result) { settled = true; worker.terminate(); resolve(event.data.result); }
      else if (event.data.error) { settled = true; worker.terminate(); reject(new Error(event.data.error)); }
    };
    worker.onerror = event => { if (!settled) { settled = true; worker.terminate(); reject(new Error(event.message || 'The region worker could not start.')); } };
    worker.postMessage({ image, options });
  });
  return { promise, cancel: () => { if (!settled) { settled = true; worker.terminate(); rejectJob(new Error('Region analysis cancelled.')); } } };
}
