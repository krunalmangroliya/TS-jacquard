import { describe, expect, it } from 'vitest';
import { applyTextureRegions, proposeTextureRegions, type TextureRegionProposal } from './region-proposals';
import type { CleanupOptions, IndexedImage } from './types';

const options: CleanupOptions = { width: 160, height: 128, read: 96, pick: 52, outlineColor: 1, protectedColors: [], strength: 'balanced', flattenTexture: true, repeatX: false, repeatY: false };
function image(width = 160, height = 128): IndexedImage { return { width, height, pixels: new Uint8Array(width * height).fill(1), palette: [[205, 168, 0], [0, 0, 128], [237, 0, 140], [0, 128, 0], [229, 209, 120]] }; }
function random(seed = 42) { return () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; }; }
function grainField(target: IndexedImage, x0: number, y0: number, x1: number, y1: number, background = 0, grain = 2) { const next = random(); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) target.pixels[y * target.width + x] = next() < .27 ? grain : background; }
const put = (target: IndexedImage, x: number, y: number, color: number) => { target.pixels[y * target.width + x] = color; };

describe('whole texture field proposals', () => {
  it('proposes thousands of grain pixels as coherent fields and retains the adjacent outline drawing', () => {
    const source = image(); grainField(source, 8, 8, 152, 120);
    // A substantial figure and contour are embedded in the noisy background.
    for (let y = 28; y < 100; y++) for (let x = 75; x <= 78; x++) put(source, x, y, 1);
    for (let x = 38; x < 122; x++) for (let y = 54; y <= 56; y++) put(source, x, y, 1);
    for (let y = 25; y < 39; y++) for (let x = 68; x < 84; x++) if ((x - 76) ** 2 + (y - 32) ** 2 < 49) put(source, x, y, 1);
    const before = source.pixels.slice(), scan = proposeTextureRegions(source, options), after = applyTextureRegions(source, scan.proposals);
    expect(scan.scannedPixels).toBe(source.pixels.length);
    expect(scan.proposals.reduce((sum, p) => sum + p.removedPixels, 0)).toBeGreaterThan(2000);
    expect(scan.proposals.length).toBeLessThan(8);
    for (let i = 0; i < source.pixels.length; i++) if (before[i] === 1) expect(after.pixels[i]).toBe(1);
    expect(source.pixels).toEqual(before); expect(after.palette).toEqual(source.palette);
    expect(proposeTextureRegions(source, options)).toEqual(scan);
  });
  it('preserves nested ornaments separated from a grain field by another palette ink', () => {
    const source = image(); grainField(source, 8, 8, 152, 120);
    for (let y = 48; y <= 72; y++) for (let x = 88; x <= 112; x++) {
      const radius = Math.hypot(x - 100, y - 60);
      if (radius <= 12) put(source, x, y, radius > 9 ? 3 : radius > 5 ? 4 : 2);
    }
    const scan = proposeTextureRegions(source, options), after = applyTextureRegions(source, scan.proposals);
    expect(scan.proposals.length).toBeGreaterThan(0);
    for (let y = 48; y <= 72; y++) for (let x = 88; x <= 112; x++) if (Math.hypot(x - 100, y - 60) <= 12) expect(after.pixels[y * source.width + x]).toBe(source.pixels[y * source.width + x]);
  });
  it('cleans a broad outline-color background without deleting solid foreground motifs', () => {
    const source = image(); grainField(source, 8, 8, 152, 120, 1, 0);
    for (let y = 40; y < 75; y++) for (let x = 50; x < 100; x++) put(source, x, y, 0);
    const result = applyTextureRegions(source, proposeTextureRegions(source, options).proposals);
    const changed = result.pixels.reduce((sum, color, i) => sum + Number(color !== source.pixels[i]), 0);
    expect(changed).toBeGreaterThan(1000);
    for (let y = 40; y < 75; y++) for (let x = 50; x < 100; x++) expect(result.pixels[y * 160 + x]).toBe(0);
    source.pixels.forEach((color, i) => { if (color === 1) expect(result.pixels[i]).toBe(1); });
  });
  it('does not spill through plain background into a distant solid motif using the same palette pair', () => {
    const source = image(320, 128);
    for (let y = 8; y < 120; y++) for (let x = 8; x < 312; x++) put(source, x, y, 0);
    grainField(source, 8, 8, 136, 120);
    for (let y = 35; y < 95; y++) for (let x = 250; x < 298; x++) put(source, x, y, 2);
    const scan = proposeTextureRegions(source, { ...options, width: 320 }), after = applyTextureRegions(source, scan.proposals);
    expect(scan.proposals.reduce((sum, p) => sum + p.removedPixels, 0)).toBeGreaterThan(2000);
    for (let y = 35; y < 95; y++) for (let x = 250; x < 298; x++) expect(after.pixels[y * 320 + x]).toBe(2);
  });
  it('does not flatten long parallel hatching adjacent to a noisy field of the same inks', () => {
    const source = image(240, 128); grainField(source, 8, 8, 112, 120);
    for (let y = 8; y < 120; y++) for (let x = 112; x < 232; x++) put(source, x, y, y % 5 === 0 ? 2 : 0);
    const after = applyTextureRegions(source, proposeTextureRegions(source, { ...options, width: 240 }).proposals);
    expect(after.pixels.some((color, i) => color !== source.pixels[i])).toBe(true);
    for (let y = 24; y < 100; y++) for (let x = 144; x < 210; x++) expect(after.pixels[y * 240 + x]).toBe(source.pixels[y * 240 + x]);
  });
  it('retains small filled diagonal leaves and tapered tips beside a noisy outline-color field', () => {
    const source = image(); grainField(source, 8, 8, 152, 120, 1, 0);
    // Clear a small island, then draw tapering leaves separated from grain by
    // a narrow gap. Their sparse diagonal boxes fail rectangular compactness.
    for (let y = 35; y < 80; y++) for (let x = 49; x < 107; x++) put(source, x, y, 1);
    const leaves: number[] = [];
    for (const [cx, cy, slope] of [[68, 52, 1], [88, 63, -.3]]) {
      for (let dy = -7; dy <= 7; dy++) for (let dx = -10; dx <= 10; dx++) {
        const along = dx + slope * dy, across = dy - slope * dx;
        if (along ** 2 / 80 + across ** 2 / 9 <= 1) { const x = cx + dx, y = cy + dy; put(source, x, y, 0); leaves.push(y * source.width + x); }
      }
    }
    const scan = proposeTextureRegions(source, options), after = applyTextureRegions(source, scan.proposals);
    expect(scan.proposals.reduce((sum, p) => sum + p.removedPixels, 0)).toBeGreaterThan(1000);
    for (const i of leaves) expect(after.pixels[i]).toBe(0);
  });
  it('keeps periodic crosshatching and flat two-ink artwork out of the grain proposals', () => {
    const source = image();
    for (let y = 8; y < 120; y++) for (let x = 8; x < 152; x++) put(source, x, y, x % 7 === 0 || y % 7 === 0 ? 4 : 0);
    expect(proposeTextureRegions(source, options).proposals).toHaveLength(0);
    source.pixels.fill(0);
    expect(proposeTextureRegions(source, options).proposals).toHaveLength(0);
  });
  it('declines an entire branching curved-hatch field whose sparse network exceeds the small-component limit', () => {
    const source = image(480, 128);
    for (let y = 8; y < 120; y++) for (let x = 8; x < 472; x++) put(source, x, y, 0);
    // Parallel long waves plus joins: >2,048 pixels and many junctions, unlike a
    // simple low-branch contour. Sparse grain nearby must not license its erasure.
    for (let x = 24; x < 456; x++) for (let line = 0; line < 11; line++) {
      const y = 45 + line * 3 + Math.round(4 * Math.sin(x / 30)); put(source, x, y, 4);
      if (x % 29 === 0) for (let dy = 0; dy < 3; dy++) put(source, x, y + dy, 4);
    }
    const next = random(789);
    for (let y = 82; y < 108; y++) for (let x = 24; x < 456; x++) if (next() < .2) put(source, x, y, 4);
    const after = applyTextureRegions(source, proposeTextureRegions(source, { ...options, width: 480 }).proposals);
    for (let x = 24; x < 456; x++) for (let line = 0; line < 11; line++) {
      const y = 45 + line * 3 + Math.round(4 * Math.sin(x / 30)); expect(after.pixels[y * 480 + x]).toBe(4);
    }
  });
  it('neither removes nor expands a protected ink', () => {
    const source = image(); grainField(source, 8, 8, 152, 120);
    for (const ink of [0, 2]) expect(proposeTextureRegions(source, { ...options, protectedColors: [ink] }).proposals).toHaveLength(0);
  });
  it('connects a texture field across an explicitly repeating seam', () => {
    const source = image(); grainField(source, 0, 8, 48, 120); grainField(source, 112, 8, 160, 120);
    const scan = proposeTextureRegions(source, { ...options, repeatX: true });
    expect(scan.proposals.some(p => p.bounds.width === 160)).toBe(true);
    const after = applyTextureRegions(source, scan.proposals);
    expect(after.pixels.some((color, i) => color !== source.pixels[i])).toBe(true);
  });
  it('keeps selection independent and rejects malformed or conflicting edits', () => {
    const source = image(); grainField(source, 8, 8, 70, 120); grainField(source, 90, 8, 152, 120, 0, 3);
    const scan = proposeTextureRegions(source, options); expect(scan.proposals.length).toBeGreaterThanOrEqual(2);
    const one = applyTextureRegions(source, [scan.proposals[0]]), wanted = new Set(scan.proposals[0].pixelIndices);
    for (let i = 0; i < source.pixels.length; i++) if (!wanted.has(i)) expect(one.pixels[i]).toBe(source.pixels[i]);
    expect(applyTextureRegions(source, []).pixels).toEqual(source.pixels);
    const base: TextureRegionProposal = { id: 1, bounds: { x: 10, y: 10, width: 1, height: 1 }, pixelIndices: new Uint32Array([1610]), replacementColors: new Uint8Array([0]), removedPixels: 1, label: 'test' };
    expect(() => applyTextureRegions(source, [base, { ...base, replacementColors: new Uint8Array([2]) }])).toThrow(/conflicting/);
    expect(() => applyTextureRegions(source, [{ ...base, pixelIndices: new Uint32Array([999999]) }])).toThrow(/pixel/);
    expect(() => applyTextureRegions(source, [{ ...base, replacementColors: new Uint8Array([250]) }])).toThrow(/ink/);
    expect(() => applyTextureRegions(source, [{ ...base, bounds: { x: 0, y: 0, width: 999, height: 1 } }])).toThrow(/dimensions/);
  });
});
