import type { IndexedImage } from './types';

export function cloneImage(image: IndexedImage): IndexedImage {
  return { ...image, pixels: image.pixels.slice(), palette: image.palette.map(c => [...c]) };
}

/** Four-connected fill never crosses a diagonal-only contact. */
export function floodFill(image: IndexedImage, x: number, y: number, color: number): IndexedImage {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height || color < 0 || color >= image.palette.length) return image;
  const start = y * image.width + x;
  const original = image.pixels[start];
  if (original === color) return image;
  const pixels = image.pixels.slice();
  const stack = new Int32Array(pixels.length);
  let length = 1;
  stack[0] = start;
  pixels[start] = color;
  const visit = (index: number) => {
    if (pixels[index] === original) { pixels[index] = color; stack[length++] = index; }
  };
  while (length) {
    const index = stack[--length];
    const col = index % image.width;
    if (col > 0) visit(index - 1);
    if (col < image.width - 1) visit(index + 1);
    if (index >= image.width) visit(index - image.width);
    if (index + image.width < pixels.length) visit(index + image.width);
  }
  return { ...image, pixels };
}

export function replaceColor(image: IndexedImage, from: number, to: number): IndexedImage {
  if (from === to || to < 0 || to >= image.palette.length) return image;
  const pixels = image.pixels.slice();
  let changed = false;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] === from) { pixels[i] = to; changed = true; }
  return changed ? { ...image, pixels } : image;
}

/** Bresenham stroke keeps a dragged one-pixel pencil continuous. */
export function drawLine(image: IndexedImage, x0: number, y0: number, x1: number, y1: number, color: number): IndexedImage {
  const pixels = image.pixels.slice();
  let changed = false;
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    if (x0 >= 0 && y0 >= 0 && x0 < image.width && y0 < image.height) {
      const index = y0 * image.width + x0;
      if (pixels[index] !== color) { pixels[index] = color; changed = true; }
    }
    if (x0 === x1 && y0 === y1) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x0 += sx; }
    if (twice <= dx) { error += dx; y0 += sy; }
  }
  return changed ? { ...image, pixels } : image;
}
