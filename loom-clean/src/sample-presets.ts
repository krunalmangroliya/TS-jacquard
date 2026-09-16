import type { IndexedImage, SourceImage } from './types';

export type SourceOrientation = 0 | 90 | 180 | 270;

export interface ReadPick { read: number; pick: number }
export interface SamplePreset extends ReadPick {
  id: string;
  label: string;
  sourceName: string;
  sourceUrl: string;
  width: number;
  height: number;
  settingsSource: 'sized-bmp';
}
export interface SampleCatalog { samples: SamplePreset[]; warnings: string[] }

/** Read/pick notation may contain spaces, mixed case, or unmatched brackets. */
export function parseReadPick(name: string): ReadPick | null {
  const match = name.match(/r\s*(\d+)\s*p\s*(\d+)(?!\d)/i);
  if (!match) return null;
  const read = Number(match[1]), pick = Number(match[2]);
  return read > 0 && pick > 0 && read <= 5000 && pick <= 5000 ? { read, pick } : null;
}

/** Stable identity ignores separators and PSD/copy/version suffixes. */
export function sampleKey(name: string): string | null {
  const id = name.match(/^\s*(\d{4,8})/);
  const part = name.match(/pallu|patto|patta|bodi|daman/i);
  if (!id || !part) return null;
  return `${id[1]}-${part[0].toLowerCase().replace('patta', 'patto')}`;
}

/** Ignore rare dirt inks when suggesting the main outline; users can override it. */
export function suggestOutlineColor(image: IndexedImage): number | null {
  if (!image.palette.length) return null;
  const counts = new Uint32Array(image.palette.length);
  for (const index of image.pixels) if (index < counts.length) counts[index]++;
  const minimum = Math.max(1, Math.ceil(image.pixels.length * .001));
  let largest = 0, darkest = -1, darkestLuminance = Infinity;
  for (let index = 0; index < image.palette.length; index++) {
    if (counts[index] > counts[largest]) largest = index;
    if (counts[index] < minimum) continue;
    const [r, g, b] = image.palette[index];
    const luminance = .2126 * r + .7152 * g + .0722 * b;
    if (luminance < darkestLuminance) { darkest = index; darkestLuminance = luminance; }
  }
  return darkest >= 0 ? darkest : largest;
}

/** Exact quarter-turn rotation; the original pixels and palette remain untouched. */
export function rotateSource(image: SourceImage, orientation: SourceOrientation): SourceImage {
  if (orientation === 0) return image;
  const pixels = new Uint8Array(image.pixels.length);
  const quarterTurn = orientation === 90 || orientation === 270;
  const width = quarterTurn ? image.height : image.width;
  const height = quarterTurn ? image.width : image.height;
  if (orientation === 180) {
    for (let i = 0; i < pixels.length; i++) pixels[pixels.length - 1 - i] = image.pixels[i];
  } else {
    for (let y = 0; y < image.height; y++) {
      const sourceRow = y * image.width;
      for (let x = 0; x < image.width; x++) {
        const destination = orientation === 90 ? x * width + (image.height - 1 - y) : (image.width - 1 - x) * width + y;
        pixels[destination] = image.pixels[sourceRow + x];
      }
    }
  }
  return { ...image, width, height, pixels, dpiX: quarterTurn ? image.dpiY : image.dpiX, dpiY: quarterTurn ? image.dpiX : image.dpiY };
}
