import type { Bounds, Master, SourceInterpretation } from '../../../packages/core/src/types';

/** Master raster previews show source proportions; sized output uses its target loom density. */
export function displayPixelAspect(master: Pick<Master, 'bounds' | 'raster'>, kind: 'master' | 'size', density: { epi: number; ppi: number }, trueProportion: boolean): number {
  if (!trueProportion) return 1;
  if (kind === 'master' && master.raster) return master.bounds.pixelAspect ?? 1;
  return density.epi / density.ppi;
}

/** Interpretation changes physical proportions only; source/crop pixel dimensions stay exact. */
export function sourceAspectSettings(width: number, height: number, kind: SourceInterpretation['kind'], density?: { epi: number; ppi: number }): { bounds: Bounds; interpretation: SourceInterpretation } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error('Source dimensions must be positive whole pixels.');
  if (kind === 'artwork') return { bounds: { w: width, h: height, pixelAspect: 1 }, interpretation: { version: 1, kind } };
  if (!density) return { bounds: { w: width, h: height, pixelAspect: null }, interpretation: { version: 1, kind } };
  const pixelAspect = density.epi / density.ppi;
  if (![density.epi, density.ppi, pixelAspect].every(value => Number.isFinite(value) && value > 0)) throw new Error('Enter positive source EPI and PPI values.');
  return { bounds: { w: width, h: height, pixelAspect }, interpretation: { version: 1, kind, density: { ...density } } };
}
