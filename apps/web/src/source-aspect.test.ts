import { describe, expect, it } from 'vitest';
import { displayPixelAspect, sourceAspectSettings } from './source-aspect';
import { resolveSize } from '../../../packages/core/src/size';
import { validateMaster } from '../../../packages/core/src/schemas';
import { DEFAULT_PALETTE, DEFAULT_PROFILE, type Master } from '../../../packages/core/src/types';

function master(): Master {
  return { schemaVersion: 1, id: 'image', workspaceId: 'local', name: 'Source interpretation', tags: [], createdAt: '', updatedAt: '',
    bounds: { w: 16, h: 8 }, repeat: { type: 'none' }, palette: structuredClone(DEFAULT_PALETTE), geometry: { nodes: {}, edges: {}, faceColors: {} }, objects: [],
    raster: { width: 16, height: 8, pixelsBase64: Buffer.from(new Uint8Array(128)).toString('base64') }, source: { fileId: 'source', widthPx: 16, heightPx: 8 },
    traceParams: { threshold: 'otsu', invert: false, minSpeckArea: 0, gapClosePx: 0, spurPrunePx: 0, simplifyTolerance: 1, fitMaxError: 1, cornerAngleDeg: 45 }, version: 1 };
}

describe('explicit source interpretation', () => {
  it('leaves pixel dimensions untouched for artwork, known grid and unknown grid', () => {
    for (const [kind, density, expected] of [['artwork', undefined, 1], ['loom-grid', undefined, null], ['loom-grid', { epi: 200, ppi: 76 }, 200 / 76]] as const) {
      const document = master(), originalPixels = document.raster!.pixelsBase64;
      const result = sourceAspectSettings(16, 8, kind, density);
      document.bounds = result.bounds; document.source.interpretation = result.interpretation;
      const saved = validateMaster(JSON.parse(JSON.stringify(document)));
      expect(saved.bounds).toEqual({ w: 16, h: 8, pixelAspect: expected });
      expect(saved.source.interpretation).toEqual({ version: 1, kind, ...(density ? { density } : {}) });
      expect(saved.raster!.pixelsBase64).toBe(originalPixels);
    }
  });
  it('keeps density in the stored image axes and requires a deliberate swap for a rotated grid', () => {
    const original = sourceAspectSettings(1478, 384, 'loom-grid', { epi: 200, ppi: 76 });
    const rotated = sourceAspectSettings(384, 1478, 'loom-grid', { epi: 76, ppi: 200 });
    expect(original.interpretation.density).toEqual({ epi: 200, ppi: 76 });
    expect(rotated.bounds.pixelAspect).toBe(76 / 200);
    expect(resolveSize(rotated.bounds, { ...DEFAULT_PROFILE, epi: 76, ppi: 200 }, { mode: 'grid', widthPx: 384, linkAspect: true })).toMatchObject({ widthPx: 384, heightPx: 1478 });
  });
  it('rejects inconsistent persisted interpretations without reinterpreting legacy masters', () => {
    const legacy = master(); expect(validateMaster(legacy)).toEqual(legacy);
    const result = sourceAspectSettings(16, 8, 'loom-grid', { epi: 200, ppi: 76 });
    const document = { ...legacy, bounds: result.bounds, source: { ...legacy.source, interpretation: result.interpretation } };
    expect(() => validateMaster({ ...document, bounds: { ...document.bounds, pixelAspect: 1 } })).toThrow('must agree');
    expect(() => validateMaster({ ...document, source: legacy.source })).toThrow('source interpretation');
    expect(() => validateMaster({ ...document, source: { ...document.source, interpretation: { ...result.interpretation, version: 2 } } })).toThrow();
    expect(() => validateMaster({ ...document, source: { ...document.source, interpretation: { ...result.interpretation, kind: 'artwork' } } })).toThrow('square source pixels');
  });
  it('rejects invalid density and keeps ordinary artwork independent of file hints', () => {
    for (const density of [{ epi: 0, ppi: 76 }, { epi: 200, ppi: -1 }, { epi: NaN, ppi: 76 }, { epi: 200, ppi: Infinity }, { epi: 1e308, ppi: 1e-308 }]) expect(() => sourceAspectSettings(16, 8, 'loom-grid', density)).toThrow('positive source EPI');
    expect(sourceAspectSettings(16, 8, 'artwork', { epi: 200, ppi: 76 })).toEqual({ bounds: { w: 16, h: 8, pixelAspect: 1 }, interpretation: { version: 1, kind: 'artwork' } });
  });
  it('shows source proportions for raster masters and target loom proportions only for sizes', () => {
    const document = master(), targetDensity = { epi: 96, ppi: 52 };
    expect(displayPixelAspect(document, 'master', targetDensity, true)).toBe(1);
    for (const pixelAspect of [1, null]) {
      document.bounds.pixelAspect = pixelAspect;
      expect(displayPixelAspect(document, 'master', targetDensity, true)).toBe(1);
    }
    document.bounds.pixelAspect = 200 / 76;
    expect(displayPixelAspect(document, 'master', targetDensity, true)).toBe(200 / 76);
    expect(displayPixelAspect(document, 'master', targetDensity, false)).toBe(1);
    expect(displayPixelAspect(document, 'size', targetDensity, true)).toBe(96 / 52);
    expect(displayPixelAspect(document, 'size', targetDensity, false)).toBe(1);
    delete document.raster;
    expect(displayPixelAspect(document, 'master', targetDensity, true)).toBe(96 / 52);
  });
});
