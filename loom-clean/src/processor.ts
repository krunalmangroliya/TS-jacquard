import type { CleanupOptions, CleanupResult, IndexedImage, Progress } from './types';
import { CLEANUP_MEDIA_TYPE, cleanupRequestBlob, decodeCleanupResult } from './cleanup-wire';

const LOCAL_LAUNCHER_MESSAGE = 'Large artwork needs the local Loom Clean launcher. Open Start-Loom-Clean.cmd on this device, then retry; a static website cannot run this larger cleanup.';

export function needsLocalCleanup(source: IndexedImage, options: CleanupOptions): boolean {
  return source.width * source.height > 24_000_000 || options.width * options.height > 4_000_000;
}

function processLocally(source: IndexedImage, options: CleanupOptions, onProgress?: (progress: Progress) => void): { promise: Promise<CleanupResult>; cancel: () => void } {
  const controller = new AbortController();
  const jobId = crypto.randomUUID();
  const promise = (async () => {
    try {
      onProgress?.({ stage: 'Preparing large artwork for cleanup on this device', percent: 5 });
      const body = cleanupRequestBlob(source, options);
      const response = await fetch('/__loom_cleanup', { method: 'POST', headers: { 'Content-Type': CLEANUP_MEDIA_TYPE, 'X-Loom-Job': jobId }, body, signal: controller.signal, credentials: 'same-origin' });
      if (!response.ok) {
        if (response.status === 404 || response.status === 405 || !response.headers.get('content-type')?.includes('application/json')) throw new Error(LOCAL_LAUNCHER_MESSAGE);
        const error = await response.json() as { error?: string };
        throw new Error(error.error || 'Local cleanup failed. Retry the artwork.');
      }
      if (!response.headers.get('content-type')?.startsWith(CLEANUP_MEDIA_TYPE)) throw new Error(LOCAL_LAUNCHER_MESSAGE);
      const result = decodeCleanupResult(await response.arrayBuffer());
      if (controller.signal.aborted) throw new Error('Cleanup cancelled.');
      onProgress?.({ stage: 'Cleanup complete', percent: 100 });
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Cleanup cancelled.');
      if (error instanceof TypeError) throw new Error(`The local cleanup service is unavailable. ${LOCAL_LAUNCHER_MESSAGE}`);
      throw error;
    }
  })();
  return { promise, cancel: () => {
    controller.abort();
    // A pooled browser connection may delay its close event; explicitly stop native work too.
    void fetch(`/__loom_cleanup/${jobId}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {});
  } };
}

export function processImage(source: IndexedImage, options: CleanupOptions, onProgress?: (progress: Progress) => void): { promise: Promise<CleanupResult>; cancel: () => void } {
  if (needsLocalCleanup(source, options)) return processLocally(source, options, onProgress);
  const worker = new Worker(new URL('./cleanup.worker.ts', import.meta.url), { type: 'module' });
  let settled = false, rejectJob: (error: Error) => void = () => {};
  const promise = new Promise<CleanupResult>((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = (event: MessageEvent<{ progress?: Progress; result?: CleanupResult; error?: string }>) => {
      if (event.data.progress) onProgress?.(event.data.progress);
      else if (event.data.result) { settled = true; worker.terminate(); resolve(event.data.result); }
      else if (event.data.error) { settled = true; worker.terminate(); reject(new Error(event.data.error)); }
    };
    worker.onerror = error => { settled = true; worker.terminate(); reject(new Error(error.message || 'Cleanup worker failed.')); };
    worker.postMessage({ source, options });
  });
  return { promise, cancel: () => { if (!settled) { settled = true; worker.terminate(); rejectJob(new Error('Cleanup cancelled.')); } } };
}
