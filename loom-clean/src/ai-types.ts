import type { IndexedImage } from './types';

export interface AiStats {
  addedPixels: number;
  removedPixels: number;
  patchesScanned: number;
  eligiblePatches: number;
  candidatePixels: number;
  scannedPixels: number;
  totalPixels: number;
  elapsedMs: number;
  provider: string;
  modelName: string;
}

/** Separate from the automatic rule result until the designer accepts the preview. */
export interface AiResult {
  image: IndexedImage;
  /** 0 unchanged, 1 removed candidate ink/noise, 2 added candidate ink/line. */
  changes: Uint8Array;
  stats: AiStats;
  warnings: string[];
}
