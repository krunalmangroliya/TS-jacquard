import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { decodeRaster, encodeRaster, importColorImage } from './raster';
import { encodePng } from './png';
import { render } from './render';
import { materializeGeometry } from './materialize';
import { remapMasterPalette, validateMaster } from './schemas';
import { applyOperation, commit, createHistory, redo, undo, validateOperation } from './ops';
import type { Geometry, Master, Palette, RasterInput, RuleConfig } from './types';

const off: RuleConfig = { minRegionPx: 0, minThicknessPx: 0, removeCheckerboard: false, connectVisibleEdges4: false };
const empty = (): Geometry => ({ nodes: {}, edges: {}, faceColors: {} });
function fixture(input: RasterInput): Master {
  const imported = importColorImage(input);
  return { schemaVersion: 1, id: 'image', workspaceId: 'test', name: 'Colored artwork', tags: [], createdAt: '2026-09-15', updatedAt: '2026-09-15',
    bounds: { w: 8, h: 8 }, repeat: { type: 'none' }, palette: imported.palette, raster: imported.raster, geometry: empty(), objects: [],
    source: { fileId: 'source', widthPx: input.width, heightPx: input.height }, traceParams: { threshold: 128, invert: false, minSpeckArea: 0, gapClosePx: 0, spurPrunePx: 0, simplifyTolerance: 1, fitMaxError: 1, cornerAngleDeg: 60 }, version: 1 };
}
function pixels(master: Master, width = master.raster!.width, height = master.raster!.height, rules = off, overrides: { x: number; y: number; colorIndex: number }[] = []) {
  const view = materializeGeometry(master);
  return render(view.geometry, view.faces, master.bounds, master.palette, width, height, rules, overrides, master.repeat, master.raster);
}
const image = (): RasterInput => ({ width: 3, height: 2, channels: 3, data: Uint8Array.from([255, 255, 255, 196, 38, 42, 196, 38, 42, 10, 20, 30, 20, 150, 30, 40, 50, 160]) });

describe('direct colored image import', () => {
  it('retains exact source colors and pixel orientation through save, materialization and indexed PNG export', () => {
    const input = image(), master = fixture(input), saved = validateMaster(JSON.parse(JSON.stringify(master)));
    expect(saved).toEqual(master); expect(saved.geometry).toEqual(empty()); expect(saved.objects).toEqual([]);
    expect(saved.palette.entries[0].exportRgb).toEqual([196, 38, 42]);
    for (const repeat of ['none', 'straight'] as const) {
      saved.repeat.type = repeat;
      const result = pixels(saved), exported = PNG.sync.read(Buffer.from(encodePng(result.grid, input.width, input.height, saved.palette)));
      for (let p = 0; p < input.width * input.height; p++) expect([...exported.data.subarray(p * 4, p * 4 + 4)]).toEqual([...input.data.subarray(p * 3, p * 3 + 3), 255]);
      expect(result.report.unassignedFaces).toBe(0);
    }
  });

  it('preserves exactly six colors, uses a white transparency matte and accepts grayscale input', () => {
    const six = importColorImage({ width: 6, height: 1, channels: 3, data: Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 200, 0]) });
    expect(six.sourceColorCount).toBe(6); expect(six.quantized).toBe(false); expect(six.palette.entries).toHaveLength(6);
    const alpha = importColorImage({ width: 3, height: 1, channels: 4, data: Uint8Array.from([99, 30, 200, 0, 255, 0, 0, 128, 10, 20, 30, 255]) });
    const colors = [...decodeRaster(alpha.raster)].map(index => alpha.palette.entries[index].exportRgb);
    expect(colors).toEqual([[255, 255, 255], [255, 127, 127], [10, 20, 30]]);
    const gray = importColorImage({ width: 2, height: 1, channels: 1, data: Uint8Array.of(16, 230) });
    expect([...decodeRaster(gray.raster)].map(index => gray.palette.entries[index].exportRgb)).toEqual([[16, 16, 16], [230, 230, 230]]);
  });

  it.each([7, 256])('keeps all %i source colors exactly unless a reduction is requested', count => {
    const data = Uint8Array.from(Array.from({ length: count }, (_, index) => [index, (index * 7) % 256, (index * 11) % 256]).flat());
    const input: RasterInput = { width: count, height: 2, channels: 3, data: Uint8Array.from([...data, ...data]) };
    const imported = importColorImage(input), master = validateMaster(fixture(input));
    expect(imported).toEqual(importColorImage(input, 'preserve'));
    expect(imported.sourceColorCount).toBe(count); expect(imported.quantized).toBe(false);
    expect(master.palette.entries).toHaveLength(count);
    const exported = PNG.sync.read(Buffer.from(encodePng(pixels(master).grid, input.width, input.height, master.palette)));
    expect([...exported.data]).toEqual(Array.from({ length: input.width * input.height }, (_, p) => [...input.data.subarray(p * 3, p * 3 + 3), 255]).flat());
    const reduced = importColorImage(input, 6);
    expect(reduced.quantized).toBe(true); expect(reduced.palette.entries.length).toBeLessThanOrEqual(6);
    const single = importColorImage(input, 1);
    expect(single.quantized).toBe(true); expect(single.palette.entries).toHaveLength(1);
  });

  it('rejects preserve mode above 256 decoded colors without silently reducing them', () => {
    const data = Uint8Array.from(Array.from({ length: 257 }, (_, index) => [index & 255, index >>> 8, 100]).flat());
    const input: RasterInput = { width: 257, height: 1, channels: 3, data };
    expect(() => importColorImage(input)).toThrow(/257 colors.*up to 256.*Select Reduce colors/);
    expect(() => importColorImage(input, 'preserve')).toThrow(/Select Reduce colors/);
    const reduced = importColorImage(input, 256);
    expect(reduced.sourceColorCount).toBe(257); expect(reduced.quantized).toBe(true);
    expect(reduced.palette.entries.length).toBeLessThanOrEqual(256);
  });

  it('quantizes more than six colors deterministically without dithering equal source pixels', () => {
    const data = Uint8Array.from(Array.from({ length: 256 }, (_, i) => [i, (i * 7) % 256, (i * 11) % 256]).flat());
    const input: RasterInput = { width: 256, height: 2, channels: 3, data: Uint8Array.from([...data, ...data]) };
    const imported = importColorImage(input, 6), again = importColorImage(input, 6);
    expect(imported).toEqual(again); expect(imported.sourceColorCount).toBe(256); expect(imported.quantized).toBe(true);
    expect(imported.palette.entries.length).toBeLessThanOrEqual(6);
    const grid = decodeRaster(imported.raster); expect(grid.slice(0, 256)).toEqual(grid.slice(256));
    expect(Math.max(...grid)).toBeLessThan(imported.palette.entries.length);
    expect(importColorImage(input, 3).palette.entries).toHaveLength(3);
  });

  it('bounds histogram storage for images with many unique RGB colors', () => {
    const count = 33000, data = new Uint8Array(count * 3);
    for (let p = 0; p < count; p++) { data[p * 3] = p >>> 16; data[p * 3 + 1] = (p >>> 8) & 255; data[p * 3 + 2] = p & 255; }
    const imported = importColorImage({ width: 330, height: 100, channels: 3, data }, 6);
    expect(imported.sourceColorCount).toBe(count); expect(imported.quantized).toBe(true);
    expect(decodeRaster(imported.raster)).toHaveLength(count); expect(imported.palette.entries.length).toBeLessThanOrEqual(6);
  });

  it('resizes from pixel centers with nearest-neighbor samples and retains the original raster', () => {
    const master = fixture({ width: 2, height: 2, channels: 1, data: Uint8Array.of(0, 60, 120, 255) });
    const before = JSON.stringify(master), source = decodeRaster(master.raster!);
    expect([...pixels(master, 4, 4).grid]).toEqual([source[0], source[0], source[1], source[1], source[0], source[0], source[1], source[1], source[2], source[2], source[3], source[3], source[2], source[2], source[3], source[3]]);
    expect([...pixels(master, 1, 1).grid]).toEqual([source[3]]);
    expect(JSON.stringify(master)).toBe(before);
  });

  it('runs pixel cleanup on imported colors and applies manual corrections last', () => {
    const data = new Uint8Array(25).fill(255); data[12] = 0;
    const master = fixture({ width: 5, height: 5, channels: 1, data }), rules = { ...off, minRegionPx: 2 };
    const clean = pixels(master, 5, 5, rules);
    expect([...clean.grid]).toEqual(Array(25).fill(0)); expect(clean.report.changedPixelsByRule.minRegion).toBe(1);
    const corrected = pixels(master, 5, 5, rules, [{ x: 2, y: 2, colorIndex: 1 }]);
    expect(corrected.grid[12]).toBe(1); expect(corrected.report.changedPixelsMask[12]).toBe(0);
    expect(decodeRaster(master.raster!)[12]).toBe(1);
  });

  it('retains the raster beneath explicit vector fills and visible strokes', () => {
    const master = fixture({ width: 8, height: 8, channels: 1, data: Uint8Array.from({ length: 64 }, (_, p) => p % 2 ? 255 : 0) });
    const geometry = empty();
    geometry.faceColors.box = { colorIndex: 1, ref: { x: 1, y: 1 } };
    geometry.nodes.a = { id: 'a', p: { x: 0, y: 6 }, kind: 'corner' };
    geometry.nodes.b = { id: 'b', p: { x: 8, y: 6 }, kind: 'corner' };
    geometry.edges.stroke = { id: 'stroke', nodeIds: ['a', 'b'], segments: [{}], width: 1, colorIndex: 1, z: 0 };
    const ground = { id: 'ground', outer: null, holes: [], areaDu: 64, ref: { x: 0, y: 0 } };
    const box = { id: 'box', outer: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], holes: [], areaDu: 4, ref: { x: 1, y: 1 } };
    const result = render(geometry, [ground, box], master.bounds, master.palette, 8, 8, off, [], master.repeat, master.raster);
    expect(result.grid[0]).toBe(1); expect(result.grid[8]).toBe(1); expect(result.grid[2]).toBe(0); expect(result.grid[3]).toBe(1);
    expect([...result.grid.slice(5 * 8, 6 * 8)]).toEqual(Array(8).fill(1));
  });
});

describe('raster persistence and palette safety', () => {
  it('checks source dimensions and cropped image metadata while allowing independent design bounds', () => {
    const master = fixture(image());
    master.source.widthPx = 4;
    expect(() => validateMaster(master)).toThrow(/dimensions must match/);
    master.source = { fileId: 'source', widthPx: 6, heightPx: 6, crop: { x: 1, y: 2, w: 3, h: 2 } };
    expect(validateMaster(master).raster).toEqual(master.raster);
    master.source.crop!.x = 4;
    expect(() => validateMaster(master)).toThrow(/inside the source/);
    master.source.crop!.x = 1.5;
    expect(() => validateMaster(master)).toThrow(/whole source pixels/);
    master.source.crop!.x = 1; master.source.crop!.h = 3;
    expect(() => validateMaster(master)).toThrow(/dimensions must match/);
  });

  it('validates canonical base64, exact lengths, dimensions, channel buffers and palette references', () => {
    for (const count of [1, 2, 3, 4, 24577]) {
      const values = Uint8Array.from({ length: count }, (_, i) => i % 256), raster = encodeRaster(count, 1, values);
      expect(raster.pixelsBase64).toBe(Buffer.from(values).toString('base64')); expect(decodeRaster(raster)).toEqual(values);
    }
    for (const pixelsBase64 of ['AA', 'AA=A', 'AB==', 'A===', '!!!!']) expect(() => decodeRaster({ width: 1, height: 1, pixelsBase64 })).toThrow(/base64/);
    expect(() => decodeRaster({ width: 2, height: 1, pixelsBase64: 'AAB=' })).toThrow(/base64/);
    expect(() => decodeRaster({ width: 100001, height: 1000, pixelsBase64: '' })).toThrow(/100 million/);
    expect(() => importColorImage({ width: 2, height: 1, channels: 3, data: Uint8Array.of(0) })).toThrow(/match/);
    for (const colorLimit of [0, 257, 1.5, NaN]) expect(() => importColorImage(image(), colorLimit)).toThrow(/1 and 256/);
    const master = fixture(image()); master.raster = encodeRaster(1, 1, Uint8Array.of(5));
    expect(() => validateMaster(master)).toThrow(/outside the palette/);
    expect(() => pixels(master)).toThrow(/outside the palette/);
    master.raster.pixelsBase64 = 'AB=='; expect(() => validateMaster(master)).toThrow(/base64/);
  });

  it.each([false, true])('merges imported color indices immutably and refuses dropping used colors (cached %s)', assumeValidated => {
    const master = fixture(image()), original = decodeRaster(master.raster!), before = JSON.stringify(master);
    const merged = applyOperation(master, { t: 'mergePalette', sourceIndex: 1, targetIndex: 3 }, { assumeValidated }).master;
    expect([...decodeRaster(merged.raster!)]).toEqual([...original].map(index => { const replacement = index === 1 ? 3 : index; return replacement > 1 ? replacement - 1 : replacement; }));
    expect(JSON.stringify(master)).toBe(before);
    expect(() => applyOperation(master, { t: 'setPalette', palette: { entries: master.palette.entries.slice(0, 1) } }, { assumeValidated })).toThrow(/outside the palette/);
    const recolored: Palette = structuredClone(master.palette); recolored.entries[0].exportRgb = [12, 34, 56];
    expect(applyOperation(master, { t: 'setPalette', palette: recolored }, { assumeValidated }).master.raster).toEqual(master.raster);
  });

  it('remaps raster indices during palette conversion and restores exact image state with undo/redo', () => {
    const master = fixture(image()), target = { entries: master.palette.entries.slice(0, 2) }, mapping = master.palette.entries.map((_, index) => index % 2);
    const mapped = remapMasterPalette(master, target, mapping);
    expect([...decodeRaster(mapped.raster!)]).toEqual([...decodeRaster(master.raster!)].map(index => mapping[index]));
    const history = commit(createHistory(master), { t: 'mergePalette', sourceIndex: 1, targetIndex: 0 });
    expect(undo(history).current).toEqual(master); expect(redo(undo(history)).current).toEqual(history.current);
  });

  it('merges color 255 explicitly and keeps all other colors through undo and redo', () => {
    const master = fixture({ width: 256, height: 1, channels: 1, data: Uint8Array.from({ length: 256 }, (_, p) => p) });
    const operation = validateOperation({ t: 'mergePalette', sourceIndex: 255, targetIndex: 7 });
    const history = commit(createHistory(master), operation);
    expect(history.current.palette.entries).toHaveLength(255);
    expect([...decodeRaster(history.current.raster!)]).toEqual([...Array.from({ length: 255 }, (_, p) => p), 7]);
    expect(undo(history).current).toEqual(master); expect(redo(undo(history)).current).toEqual(history.current);
    expect(() => validateOperation({ t: 'mergePalette', sourceIndex: 256, targetIndex: 7 })).toThrow();
    expect(() => validateOperation({ t: 'mergePalette', sourceIndex: 7, targetIndex: 256 })).toThrow();
  });
});
