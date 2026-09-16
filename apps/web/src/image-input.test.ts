import { afterEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { encodeBmp } from '../../../packages/core/src/bmp';
import { DEFAULT_PALETTE, DEFAULT_PROFILE } from '../../../packages/core/src/types';
import { inspectImageHeader, readImageFile, sourcePngBase64 } from './image-input';

function png(width = 16, height = 8): Uint8Array {
  return PNG.sync.write(new PNG({ width, height }));
}
function bmp(width = 16, height = 8): Uint8Array {
  return encodeBmp(new Uint8Array(width * height), width, height, DEFAULT_PALETTE, DEFAULT_PROFILE);
}
function jpeg(width = 16, height = 8, progressive = false): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 4, 0, 0, 0xff, progressive ? 0xc2 : 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
}
function file(bytes: Uint8Array, name = 'image.png', type = 'image/png'): File {
  return new File([new Uint8Array(bytes).buffer], name, { type });
}
function decode(width = 16, height = 8) {
  const close = vi.fn(), createImageBitmap = vi.fn(async () => ({ width, height, close }));
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  return { close, createImageBitmap };
}

function pngWithDensity(xPerMeter: number, yPerMeter: number, unit = 1): Uint8Array {
  const source = png(), chunk = new Uint8Array(21), view = new DataView(chunk.buffer);
  view.setUint32(0, 9); chunk.set([112, 72, 89, 115], 4);
  view.setUint32(8, xPerMeter); view.setUint32(12, yPerMeter); chunk[16] = unit;
  let crc = 0xffffffff;
  for (const value of chunk.subarray(4, 17)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  view.setUint32(17, (crc ^ 0xffffffff) >>> 0);
  const result = new Uint8Array(source.length + chunk.length); result.set(source.subarray(0, 33)); result.set(chunk, 33); result.set(source.subarray(33), 54); return result;
}

afterEach(() => vi.unstubAllGlobals());

describe('image input header validation', () => {
  it('recognizes PNG, palette BMP, baseline JPEG, and progressive JPEG from their contents', () => {
    expect(inspectImageHeader(png())).toEqual({ format: 'png', width: 16, height: 8 });
    expect(inspectImageHeader(bmp())).toMatchObject({ format: 'bmp', width: 16, height: 8 });
    expect(inspectImageHeader(jpeg())).toEqual({ format: 'jpeg', width: 16, height: 8 });
    expect(inspectImageHeader(jpeg(16, 8, true))).toEqual({ format: 'jpeg', width: 16, height: 8 });
  });
  it('supports top-down Windows BMPs and OS/2 core BMP headers', () => {
    const topDown = bmp(); new DataView(topDown.buffer).setInt32(22, -8, true);
    expect(inspectImageHeader(topDown).height).toBe(8);
    const core = new Uint8Array(50), view = new DataView(core.buffer);
    core.set([0x42, 0x4d]); view.setUint32(10, 26, true); view.setUint32(14, 12, true); view.setUint16(18, 16, true); view.setUint16(20, 8, true); view.setUint16(22, 1, true);
    expect(inspectImageHeader(core)).toEqual({ format: 'bmp', width: 16, height: 8 });
  });
  it('reads typed-array slices without reading the surrounding buffer', () => {
    const source = png(), padded = new Uint8Array(source.length + 14); padded.set(source, 7);
    expect(inspectImageHeader(padded.subarray(7, 7 + source.length)).width).toBe(16);
  });
  it('rejects non-image files and malformed or truncated metadata', () => {
    for (const bytes of [new Uint8Array(), new TextEncoder().encode('<svg width="16" height="8"></svg>'), png().subarray(0, 24), jpeg().subarray(0, 18)]) expect(() => inspectImageHeader(bytes)).toThrow(/valid BMP, PNG, or JPG/);
    const badPng = png(); badPng[11] = 12;
    const badBmp = bmp(); new DataView(badBmp.buffer).setUint32(14, 0x7fffffff, true);
    const badJpeg = jpeg(); badJpeg[11] = 1;
    const badComponents = jpeg(); badComponents[17] = 3;
    for (const bytes of [badPng, badBmp, badJpeg, badComponents]) expect(() => inspectImageHeader(bytes)).toThrow(/valid BMP, PNG, or JPG/);
  });
  it('rejects sources outside the side and area limits before decoding', () => {
    for (const [width, height] of [[7, 8], [8, 0], [8193, 8], [8192, 8192]]) expect(() => inspectImageHeader(jpeg(width, height))).toThrow(/40 million pixels/);
    expect(inspectImageHeader(jpeg(8192, 8)).width).toBe(8192);
  });
});

describe('browser image validation', () => {
  it('uses file contents rather than a misleading extension or MIME type', async () => {
    const bitmap = decode();
    await expect(readImageFile(file(bmp(), 'drawing.jpg', 'image/jpeg'))).resolves.toMatchObject({ width: 16, height: 8 });
    expect(bitmap.close).toHaveBeenCalledOnce();
    await expect(readImageFile(file(new TextEncoder().encode('This is not PNG data.'), 'drawing.png'))).rejects.toThrow(/valid BMP, PNG, or JPG/);
    expect(bitmap.createImageBitmap).toHaveBeenCalledOnce();
  });
  it('rejects corrupt pixel data reported by the browser', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('Decode failed')));
    await expect(readImageFile(file(png()))).rejects.toThrow(/damaged or unsupported/);
  });
  it('bounds both the file size and metadata before decoding', async () => {
    const bitmap = decode(), oversized = { size: 110_000_001, arrayBuffer: vi.fn() } as unknown as File;
    await expect(readImageFile(oversized)).rejects.toThrow(/110 MB/);
    await expect(readImageFile(file(jpeg(8192, 8192)))).rejects.toThrow(/40 million pixels/);
    expect(oversized.arrayBuffer).not.toHaveBeenCalled(); expect(bitmap.createImageBitmap).not.toHaveBeenCalled();
  });
  it('accepts EXIF-rotated JPEG dimensions and rejects unexplained dimension changes', async () => {
    const bitmap = decode(8, 16);
    await expect(readImageFile(file(jpeg(), 'portrait.jpeg', 'image/jpeg'))).resolves.toEqual({ width: 8, height: 16 });
    await expect(readImageFile(file(png()))).rejects.toThrow(/damaged or unsupported/);
    expect(bitmap.close).toHaveBeenCalledTimes(2);
  });
  it('reuses validated metadata for immutable files', async () => {
    const bitmap = decode(), source = file(png());
    await readImageFile(source); await readImageFile(source);
    expect(bitmap.createImageBitmap).toHaveBeenCalledOnce();
  });
});

describe('optional source density suggestions', () => {
  it('reads horizontal and vertical BMP densities without changing portrait or top-down orientation', () => {
    const source = encodeBmp(new Uint8Array(16 * 8), 8, 16, DEFAULT_PALETTE, { epi: 200, ppi: 76 });
    expect(inspectImageHeader(source)).toMatchObject({ width: 8, height: 16, densityHint: { source: 'bmp', epi: 7874 * .0254, ppi: 2992 * .0254 } });
    new DataView(source.buffer).setInt32(22, -16, true);
    expect(inspectImageHeader(source)).toMatchObject({ width: 8, height: 16, densityHint: { epi: 7874 * .0254, ppi: 2992 * .0254 } });
  });
  it('reads only valid PNG pHYs metadata with metre units and a matching CRC', () => {
    expect(inspectImageHeader(pngWithDensity(7874, 2992)).densityHint).toEqual({ source: 'png', epi: 7874 * .0254, ppi: 2992 * .0254 });
    expect(inspectImageHeader(pngWithDensity(7874, 2992, 0)).densityHint).toBeUndefined();
    expect(inspectImageHeader(pngWithDensity(0, 2992)).densityHint).toBeUndefined();
    expect(inspectImageHeader(pngWithDensity(0xffffffff, 2992)).densityHint).toBeUndefined();
    const damaged = pngWithDensity(7874, 2992); damaged[50] ^= 1;
    expect(inspectImageHeader(damaged).densityHint).toBeUndefined();
    const duplicate = pngWithDensity(7874, 2992), bytes = new Uint8Array(duplicate.length + 21);
    bytes.set(duplicate.subarray(0, 54)); bytes.set(duplicate.subarray(33, 54), 54); bytes.set(duplicate.subarray(54), 75);
    expect(inspectImageHeader(bytes).densityHint).toBeUndefined();
  });
  it('ignores absent, negative and implausible metadata and never infers density from a file name', async () => {
    decode(); const source = bmp(), view = new DataView(source.buffer);
    for (const value of [0, -1, 0x7fffffff]) { view.setInt32(38, value, true); expect(inspectImageHeader(source).densityHint).toBeUndefined(); }
    view.setInt32(38, 0, true); view.setInt32(42, 0, true);
    await expect(readImageFile(file(source, 'ready-r200-p76.bmp'))).resolves.toEqual({ width: 16, height: 8 });
  });
  it('keeps metadata suggestions across browser validation without exposing mutable cached metadata', async () => {
    decode(); const source = file(pngWithDensity(7874, 2992)), first = await readImageFile(source);
    expect(first.densityHint).toMatchObject({ source: 'png', epi: 7874 * .0254 });
    first.densityHint!.epi = 999;
    expect((await readImageFile(source)).densityHint!.epi).toBe(7874 * .0254);
  });
});

describe('source PNG storage', () => {
  function fakeFileReader() {
    vi.stubGlobal('FileReader', class {
      result: string | null = null;
      onload?: () => void;
      async readAsDataURL(blob: Blob) {
        this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
        this.onload?.();
      }
    });
  }
  it('preserves original PNG bytes', async () => {
    decode(); fakeFileReader(); const source = png();
    expect(await sourcePngBase64(file(source))).toBe(Buffer.from(source).toString('base64'));
  });
  it.each(['bmp', 'jpeg'] as const)('converts %s to a full-resolution, white-matted PNG', async format => {
    const bitmap = decode(); fakeFileReader();
    const converted = file(png()), context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob: vi.fn((callback: (blob: Blob) => void, mime: string) => {
      expect(canvas.width).toBe(16); expect(canvas.height).toBe(8); expect(mime).toBe('image/png'); callback(converted);
    }) };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    expect(await sourcePngBase64(file(format === 'bmp' ? bmp() : jpeg(), `art.${format}`))).toBe(Buffer.from(await converted.arrayBuffer()).toString('base64'));
    expect(context.fillStyle).toBe('#ffffff'); expect(context.fillRect).toHaveBeenCalledWith(0, 0, 16, 8); expect(context.drawImage).toHaveBeenCalledOnce();
    expect(canvas.getContext).toHaveBeenCalledWith('2d', { alpha: false }); expect(bitmap.close).toHaveBeenCalledTimes(2);
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
  });
  it('reports a canvas encoding failure and releases the bitmap', async () => {
    const bitmap = decode();
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (callback: (blob: Blob | null) => void) => callback(null) }) });
    await expect(sourcePngBase64(file(bmp()))).rejects.toThrow(/save this image as PNG/);
    expect(bitmap.close).toHaveBeenCalledTimes(2);
  });
});
