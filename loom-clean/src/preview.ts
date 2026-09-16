import type { IndexedImage } from './types';

export const MAX_PREVIEW_PIXELS = 1024 * 1024;
export const PREVIEW_TILE_SIDE = 1024;
export interface PixelRect { x: number; y: number; width: number; height: number }
export interface PreviewStyle {
  changes?: boolean;
  baseline?: IndexedImage;
  automaticImage?: IndexedImage;
  changeKinds?: Uint8Array;
}

export function overviewDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 1536 / Math.max(width, height), Math.sqrt(MAX_PREVIEW_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function visibleSourceRect(image: { width: number; height: number }, viewport: { width: number; height: number }, camera: { x: number; y: number; scale: number }, yRatio = 1): PixelRect | null {
  if (!(camera.scale > 0) || !(yRatio > 0)) return null;
  const x = Math.max(0, Math.floor(-camera.x / camera.scale));
  const y = Math.max(0, Math.floor(-camera.y / (camera.scale * yRatio)));
  const right = Math.min(image.width, Math.ceil((viewport.width - camera.x) / camera.scale));
  const bottom = Math.min(image.height, Math.ceil((viewport.height - camera.y) / (camera.scale * yRatio)));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function* previewTiles(rect: PixelRect): Generator<PixelRect> {
  for (let y = rect.y; y < rect.y + rect.height; y += PREVIEW_TILE_SIDE) {
    for (let x = rect.x; x < rect.x + rect.width; x += PREVIEW_TILE_SIDE) {
      yield { x, y, width: Math.min(PREVIEW_TILE_SIDE, rect.x + rect.width - x), height: Math.min(PREVIEW_TILE_SIDE, rect.y + rect.height - y) };
    }
  }
}

/** Bounds every RGBA allocation; small previews area-average the indexed source directly. */
export function renderPreviewRegion(image: IndexedImage, rect: PixelRect, width: number, height: number, style: PreviewStyle = {}): Uint8ClampedArray<ArrayBuffer> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PREVIEW_PIXELS) throw new Error('Preview exceeds the bounded pixel budget.');
  if (rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > image.width || rect.y + rect.height > image.height || width > rect.width || height > rect.height) throw new Error('Invalid preview crop.');
  const data = new Uint8ClampedArray(width * height * 4);
  const pack = (color: readonly number[]) => (color[0] << 16) | (color[1] << 8) | color[2];
  const colors = image.palette.map(pack);
  const baselineColors = style.baseline?.palette.map(pack);
  const automaticColors = style.automaticImage?.palette.map(pack);
  const grayColors = image.palette.map(color => {
    const gray = Math.round((color[0] + color[1] + color[2]) / 3 * .32);
    return (gray << 16) | (gray << 8) | gray;
  });
  const colorAt = (index: number): number => {
    const ink = image.pixels[index];
    const color = colors[ink];
    if (!style.changes || !style.baseline || !baselineColors) return color;
    if (color === baselineColors[style.baseline.pixels[index]]) return grayColors[ink];
    if (style.automaticImage && automaticColors && color !== automaticColors[style.automaticImage.pixels[index]]) return 0x46cdec;
    return style.changeKinds?.[index] === 3 ? 0x7eea7c : 0xeb5dba;
  };
  if (width === rect.width && height === rect.height) {
    for (let y = 0; y < height; y++) {
      const row = (rect.y + y) * image.width + rect.x;
      for (let x = 0; x < width; x++) {
        const color = colorAt(row + x), at = (y * width + x) * 4;
        data[at] = color >>> 16; data[at + 1] = (color >>> 8) & 255; data[at + 2] = color & 255; data[at + 3] = 255;
      }
    }
    return data;
  }
  const stepX = rect.width / width, stepY = rect.height / height;
  const area = stepX * stepY;
  for (let y = 0; y < height; y++) {
    const y0 = rect.y + y * stepY, y1 = rect.y + (y + 1) * stepY;
    const top = Math.floor(y0), bottom = Math.min(rect.y + rect.height, Math.ceil(y1));
    for (let x = 0; x < width; x++) {
      const x0 = rect.x + x * stepX, x1 = rect.x + (x + 1) * stepX;
      const left = Math.floor(x0), right = Math.min(rect.x + rect.width, Math.ceil(x1));
      let r = 0, g = 0, b = 0;
      for (let sy = top; sy < bottom; sy++) {
        const weightY = Math.min(y1, sy + 1) - Math.max(y0, sy), row = sy * image.width;
        for (let sx = left; sx < right; sx++) {
          const weight = weightY * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          const color = colorAt(row + sx);
          r += (color >>> 16) * weight; g += ((color >>> 8) & 255) * weight; b += (color & 255) * weight;
        }
      }
      const at = (y * width + x) * 4;
      data[at] = r / area; data[at + 1] = g / area; data[at + 2] = b / area; data[at + 3] = 255;
    }
  }
  return data;
}
