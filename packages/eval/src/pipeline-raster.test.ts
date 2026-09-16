import { afterEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { importColorImage, decodeRaster } from '../../core/src/raster';
import { DEFAULT_PROFILE, type Master, type RuleConfig } from '../../core/src/types';
import { renderMaster } from './pipeline';

const off: RuleConfig = { minRegionPx: 0, minThicknessPx: 0, removeCheckerboard: false, connectVisibleEdges4: false };
function fixture(): Master {
  const data = Uint8Array.from({ length: 64 }, (_, p) => (p % 8 < 4 ? 0 : 60) + (p < 32 ? 0 : 120));
  const { raster, palette } = importColorImage({ width: 8, height: 8, channels: 1, data });
  return { schemaVersion: 1, id: 'image', workspaceId: 'test', name: 'Imported artwork', tags: [], createdAt: '2026-09-15', updatedAt: '2026-09-15', version: 1,
    bounds: { w: 8, h: 8 }, repeat: { type: 'none' }, palette, raster, geometry: { nodes: {}, edges: {}, faceColors: {} }, objects: [],
    source: { fileId: 'source', widthPx: 8, heightPx: 8 }, traceParams: { threshold: 'otsu', invert: false, minSpeckArea: 0, gapClosePx: 0, spurPrunePx: 0, simplifyTolerance: 1, fitMaxError: 1, cornerAngleDeg: 45 } };
}

afterEach(() => vi.unstubAllGlobals());
describe('imported image masters in CLI and local inspector', () => {
  it('renders a downloaded JSON master into indexed PNG/BMP at the requested size', () => {
    const original = fixture(), master = JSON.parse(JSON.stringify(original)) as Master;
    const result = renderMaster(master, DEFAULT_PROFILE, { mode: 'grid', widthPx: 8, heightPx: 8, linkAspect: false }, off);
    expect(result.grid).toEqual(decodeRaster(master.raster!)); expect(result.report.colorsUsed).toEqual([0, 1, 2, 3]);
    const png = PNG.sync.read(Buffer.from(result.png));
    for (let p = 0; p < 64; p++) expect(png.data[p * 4]).toBe((p % 8 < 4 ? 0 : 60) + (p < 32 ? 0 : 120));
    const resized = renderMaster(master, DEFAULT_PROFILE, { mode: 'grid', widthPx: 2, heightPx: 2, linkAspect: false }, off);
    expect([...resized.grid].map(index => master.palette.entries[index].exportRgb[0])).toEqual([0, 60, 120, 180]);
    expect([...resized.bmp.slice(0, 2)]).toEqual([0x42, 0x4d]); expect(master).toEqual(original);
  });

  it('initializes and resizes imported artwork in the inspector worker and downloads matching BMP bytes', async () => {
    const messages: Record<string, unknown>[] = [];
    const scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(message: Record<string, unknown>): void } = { onmessage: null, postMessage: message => { messages.push(message); } };
    vi.stubGlobal('self', scope);
    await import('./stroke-editor-worker');
    const master = fixture(), masterJson = JSON.stringify(master);
    scope.onmessage!({ data: { type: 'init', masterJson, profile: DEFAULT_PROFILE, rules: off, widthPx: 8, heightPx: 8 } });
    expect(messages.filter(message => message.type === 'error')).toEqual([]);
    const preview = messages.find(message => message.type === 'preview')!;
    expect(new Uint8Array(preview.grid as ArrayBuffer)).toEqual(decodeRaster(master.raster!));
    scope.onmessage!({ data: { type: 'size', widthPx: 2, heightPx: 2, revision: 1 } });
    scope.onmessage!({ data: { type: 'download', format: 'bmp', revision: 1 } });
    scope.onmessage!({ data: { type: 'download', format: 'master', revision: 1 } });
    expect(messages.filter(message => message.type === 'error')).toEqual([]);
    const expected = renderMaster(master, DEFAULT_PROFILE, { mode: 'grid', widthPx: 2, heightPx: 2, linkAspect: false }, off);
    const bmp = messages.find(message => message.type === 'download' && message.format === 'bmp')!;
    expect(new Uint8Array(bmp.buffer as ArrayBuffer)).toEqual(expected.bmp);
    const saved = messages.find(message => message.type === 'download' && message.format === 'master')!;
    expect(JSON.parse(new TextDecoder().decode(saved.buffer as ArrayBuffer))).toEqual(master);
  });
});
