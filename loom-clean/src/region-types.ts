import type { TextureRegionProposal } from './region-proposals';

export interface RegionScanResult {
  proposals: TextureRegionProposal[];
  scannedPixels: number;
  totalPixels: number;
  elapsedMs: number;
  limited?: boolean;
}
export type RegionView = 'before' | 'proposal' | 'changes';
