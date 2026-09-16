import type {Palette, PaletteEntry} from '../../../packages/core/src/types';

/** A review threshold, not a verdict that a color is unwanted. */
export const LOW_COLOR_USAGE_PERCENT = 0.1;
const MAX_SIMILAR_RGB_DISTANCE_SQUARED = 24 * 24;

export interface PaletteUsageEntry {
  entry: PaletteEntry;
  pixelCount: number;
  percentage: number;
  canMerge: boolean;
  /** A close, more common export shade; selection still requires user review. */
  suggestedTarget?: PaletteEntry;
}

export interface PaletteUsageAnalysis {
  rare: PaletteUsageEntry[];
  unused: PaletteEntry[];
  totalPixels: number;
}

function rgbDistanceSquared(a: PaletteEntry, b: PaletteEntry): number {
  return a.exportRgb.reduce((sum, channel, i) => sum + (channel - b.exportRgb[i]) ** 2, 0);
}

/** Counts must describe every pixel of the stated source or final output. */
export function analyzePaletteUsage(palette: Palette, counts: readonly number[] | undefined, totalPixels: number): PaletteUsageAnalysis | undefined {
  if (!counts || !Number.isSafeInteger(totalPixels) || totalPixels <= 0 || palette.entries.length === 0) return;
  const indices = new Set(palette.entries.map(entry => entry.index));
  if (indices.size !== palette.entries.length || palette.entries.some(entry => !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= counts.length)) return;
  let sum = 0;
  for (let index = 0; index < counts.length; index++) {
    const count = counts[index];
    if (!Number.isSafeInteger(count) || count < 0 || (count > 0 && !indices.has(index))) return;
    sum += count;
  }
  if (sum !== totalPixels) return;

  const unused: PaletteEntry[] = [];
  const rare: PaletteUsageEntry[] = [];
  for (const entry of palette.entries) {
    const pixelCount = counts[entry.index];
    if (pixelCount === 0) { unused.push(entry); continue; }
    // The integer comparison includes exactly 0.1% without rounding it first.
    if (pixelCount * 1000 > totalPixels) continue;
    const canMerge = entry.index !== 0;
    const candidates = canMerge ? palette.entries.filter(candidate => candidate.index !== entry.index && counts[candidate.index] > pixelCount)
      .map(candidate => ({entry: candidate, distance: rgbDistanceSquared(entry, candidate)}))
      .filter(candidate => candidate.distance <= MAX_SIMILAR_RGB_DISTANCE_SQUARED)
      .sort((a, b) => a.distance - b.distance || counts[b.entry.index] - counts[a.entry.index] || a.entry.index - b.entry.index) : [];
    rare.push({entry, pixelCount, percentage: pixelCount / totalPixels * 100, canMerge, suggestedTarget: candidates[0]?.entry});
  }
  rare.sort((a, b) => a.pixelCount - b.pixelCount || a.entry.index - b.entry.index);
  return {rare, unused, totalPixels};
}

export function formatColorUsagePercentage(percentage: number): string {
  if (percentage > 0 && percentage < 0.0001) return '<0.0001%';
  return `${percentage.toLocaleString(undefined, {maximumFractionDigits: 4})}%`;
}
