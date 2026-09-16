import { proposeTextureRegions } from './region-proposals';
import type { CleanupOptions, IndexedImage, Progress } from './types';
import type { RegionScanResult } from './region-types';

self.onmessage = (event: MessageEvent<{ image: IndexedImage; options: CleanupOptions }>) => {
  try {
    const started = performance.now();
    self.postMessage({ progress: { stage: 'Finding grain fields across the canvas', percent: 8 } satisfies Progress });
    const found = proposeTextureRegions(event.data.image, event.data.options);
    const result: RegionScanResult = { ...found, elapsedMs: performance.now() - started };
    self.postMessage({ result }, { transfer: result.proposals.flatMap(p => [p.pixelIndices.buffer, p.replacementColors.buffer]) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Region analysis failed. Your canvas is unchanged.' });
  }
};
