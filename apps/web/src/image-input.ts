/** File metadata is only a suggestion; it is not confirmed loom density. */
export interface ImageDensityHint { epi: number; ppi: number; source: 'bmp' | 'png' }
export interface ImageInputInfo { format: 'png' | 'jpeg' | 'bmp'; width: number; height: number; densityHint?: ImageDensityHint }

const MAX_FILE_BYTES = 110_000_000;
const invalidImage = () => new Error('Choose a valid BMP, PNG, or JPG image. The selected file is damaged or unsupported.');
const validatedFiles = new WeakMap<File, ImageInputInfo>();

function densityHint(xPerMeter: number, yPerMeter: number, source: ImageDensityHint['source']): ImageDensityHint | undefined {
  const epi = xPerMeter * .0254, ppi = yPerMeter * .0254;
  // Outlandish printer metadata is not a useful loom-setting suggestion.
  if (![epi, ppi].every(value => Number.isFinite(value) && value >= 1 && value <= 10_000)) return;
  return { epi, ppi, source };
}

function validPngCrc(bytes: Uint8Array, offset: number, length: number, expected: number): boolean {
  let crc = 0xffffffff;
  for (let i = offset; i < offset + length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return ((crc ^ 0xffffffff) >>> 0) === expected;
}

function pngDensityHint(bytes: Uint8Array, view: DataView): ImageDensityHint | undefined {
  let result: ImageDensityHint | undefined, seen = false;
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'IDAT' || type === 'IEND') return result;
    if (type === 'pHYs') {
      if (seen || length !== 9 || !validPngCrc(bytes, offset + 4, length + 4, view.getUint32(offset + 8 + length))) return;
      seen = true;
      if (bytes[offset + 16] === 1) result = densityHint(view.getUint32(offset + 8), view.getUint32(offset + 12), 'png');
    }
    offset += length + 12;
  }
  return;
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || width > 8192 || height > 8192 || width * height > 40_000_000) {
    throw new Error('Use an image between 8 and 8,192 pixels on each side, with no more than 40 million pixels.');
  }
}

/** Inspect dimensions before asking the browser to allocate decoded image pixels. */
export function inspectImageHeader(bytes: Uint8Array): ImageInputInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let info: ImageInputInfo;
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) {
    if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw invalidImage();
    info = { format: 'png', width: view.getUint32(16), height: view.getUint32(20) };
    const hint = pngDensityHint(bytes, view); if (hint) info.densityHint = hint;
  } else if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const dibSize = view.getUint32(14, true);
    if (dibSize === 12) {
      if (view.getUint16(22, true) !== 1) throw invalidImage();
      info = { format: 'bmp', width: view.getUint16(18, true), height: view.getUint16(20, true) };
    } else {
      if (dibSize < 40 || dibSize > bytes.length - 14 || bytes.length < 54 || view.getUint16(26, true) !== 1) throw invalidImage();
      info = { format: 'bmp', width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
      const hint = densityHint(view.getInt32(38, true), view.getInt32(42, true), 'bmp'); if (hint) info.densityHint = hint;
    }
    const offset = view.getUint32(10, true);
    if (offset < 14 + dibSize || offset >= bytes.length) throw invalidImage();
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let frame: ImageInputInfo | undefined;
    for (let offset = 2; offset < bytes.length;) {
      if (bytes[offset++] !== 0xff) throw invalidImage();
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) throw invalidImage();
      const marker = bytes[offset++];
      if (marker === 0 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) throw invalidImage();
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw invalidImage();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw invalidImage();
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (length < 11 || bytes[offset + 7] === 0 || length !== 8 + 3 * bytes[offset + 7]) throw invalidImage();
        frame = { format: 'jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
        break;
      }
      offset += length;
    }
    if (!frame) throw invalidImage();
    info = frame;
  } else {
    throw invalidImage();
  }
  validateDimensions(info.width, info.height);
  return info;
}

async function decodeImage(file: File): Promise<ImageBitmap> {
  try { return await createImageBitmap(file); }
  catch { throw invalidImage(); }
}

export async function readImageFile(file: File): Promise<{ width: number; height: number; densityHint?: ImageDensityHint }> {
  const cached = validatedFiles.get(file);
  if (cached) return { width: cached.width, height: cached.height, ...(cached.densityHint ? { densityHint: { ...cached.densityHint } } : {}) };
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('Choose an image file smaller than 110 MB.');
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw new Error('Could not read the selected image.'); }
  const header = inspectImageHeader(bytes), bitmap = await decodeImage(file);
  try {
    validateDimensions(bitmap.width, bitmap.height);
    // JPEG EXIF orientation can exchange the displayed width and height.
    if (!(bitmap.width === header.width && bitmap.height === header.height) && !(header.format === 'jpeg' && bitmap.width === header.height && bitmap.height === header.width)) throw invalidImage();
    const dimensions = { width: bitmap.width, height: bitmap.height, ...(header.densityHint ? { densityHint: { ...header.densityHint } } : {}) };
    validatedFiles.set(file, { format: header.format, ...dimensions, ...(header.densityHint ? { densityHint: { ...header.densityHint } } : {}) });
    return dimensions;
  } finally { bitmap.close(); }
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) { reject(new Error('Could not read the selected image.')); return; }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.onerror = reader.onabort = () => reject(new Error('Could not read the selected image.'));
    reader.readAsDataURL(blob);
  });
}

/** Store every supported source through the existing PNG source endpoint. */
export async function sourcePngBase64(file: File): Promise<string> {
  const dimensions = await readImageFile(file);
  if (validatedFiles.get(file)!.format === 'png') return blobBase64(file);
  const bitmap = await decodeImage(file), canvas = document.createElement('canvas');
  try {
    canvas.width = dimensions.width; canvas.height = dimensions.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('This browser could not prepare the image.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not save this image as PNG.')), 'image/png'));
    if (png.size > MAX_FILE_BYTES) throw new Error('The converted image exceeds 110 MB. Choose a smaller source image.');
    return await blobBase64(png);
  } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
}
