import type { CleanupOptions, IndexedImage, Progress } from './types';
import type { AiResult } from './ai-types';

export function analyzeWithAi(image: IndexedImage, options: CleanupOptions, onProgress?: (progress: Progress) => void): { promise: Promise<AiResult>; cancel: () => void } {
  const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectJob: (error: Error) => void = () => {};
  const promise = new Promise<AiResult>((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = (event: MessageEvent<{ progress?: Progress; result?: AiResult; error?: string }>) => {
      if (settled) return;
      if (event.data.progress) onProgress?.(event.data.progress);
      else if (event.data.result) { settled = true; worker.terminate(); resolve(event.data.result); }
      else if (event.data.error) { settled = true; worker.terminate(); reject(new Error(event.data.error)); }
    };
    worker.onerror = event => { if (!settled) { settled = true; worker.terminate(); reject(new Error(event.message || 'The local AI worker could not start.')); } };
    // Structured clone preserves the editor's source and undo buffers.
    worker.postMessage({ image, options });
  });
  return { promise, cancel: () => { if (!settled) { settled = true; worker.terminate(); rejectJob(new Error('AI analysis cancelled.')); } } };
}
