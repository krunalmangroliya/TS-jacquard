export type RGB = [number, number, number];
export interface IndexedImage {
  width: number;
  height: number;
  pixels: Uint8Array;
  palette: RGB[];
}
export interface SourceImage extends IndexedImage {
  name: string;
  dpiX?: number;
  dpiY?: number;
  originalColors: number;
}
export interface CleanupOptions {
  width: number;
  height: number;
  read: number;
  pick: number;
  strength: 'gentle' | 'balanced' | 'strong';
  flattenTexture: boolean;
  outlineColor: number | null;
  protectedColors: number[];
  repeatX: boolean;
  repeatY: boolean;
}
export interface CleanupStats {
  changedPixels: number;
  specksRemoved: number;
  gapsRepaired: number;
  texturePixels: number;
  repeatedPixels: number;
  elapsedMs: number;
  sourceColors: number;
  linePaths?: number;
  grainFragments?: number;
  lineCandidates?: number;
}
export interface CleanupResult {
  image: IndexedImage;
  baseline: Uint8Array;
  changes: Uint8Array;
  stats: CleanupStats;
  warnings: string[];
}
export interface Progress { stage: string; percent: number }
export const MAX_SOURCE_PIXELS = 40_000_000;
export const MAX_OUTPUT_PIXELS = 8_000_000;
export const MAX_SIDE = 8192;
