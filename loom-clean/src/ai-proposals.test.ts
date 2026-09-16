import { describe, expect, it } from 'vitest';
import { AI_CORE_SIDE, AI_HALO, AI_PATCH_SIDE, applyAiPredictions, generateAiPatches, type AiPatch, type AiPrediction } from './ai-proposals';
import type { CleanupOptions, IndexedImage } from './types';

const options: CleanupOptions = { width: 64, height: 64, read: 96, pick: 52, strength: 'balanced', flattenTexture: true, outlineColor: 1, protectedColors: [], repeatX: false, repeatY: false };
const thresholds = { add: .97, remove: .97, margin: .04 };
const blank = (width = 64, height = 64): IndexedImage => ({ width, height, pixels: new Uint8Array(width * height), palette: [[240, 231, 120], [23, 60, 175], [175, 34, 67]] });
const dot = (image: IndexedImage, x: number, y: number, color = 1) => { image.pixels[y * image.width + x] = color; };
const hline = (image: IndexedImage, x0: number, x1: number, y: number, color = 1) => { for (let x = x0; x <= x1; x++) dot(image, x, y, color); };

// These fixed logits only test proposal arbitration/guards, never model accuracy.
function prediction(image: IndexedImage, color: number, edits: Array<[number, number, 'add' | 'remove', number?]>): AiPrediction {
  const x = Math.floor(edits[0][0] / AI_CORE_SIDE) * AI_CORE_SIDE - AI_HALO;
  const y = Math.floor(edits[0][1] / AI_CORE_SIDE) * AI_CORE_SIDE - AI_HALO;
  const patch: AiPatch = { id: ((y + AI_HALO) / AI_CORE_SIDE * Math.ceil(image.width / AI_CORE_SIDE) + (x + AI_HALO) / AI_CORE_SIDE) * image.palette.length + color, color, x, y, mask: new Float32Array(AI_PATCH_SIDE ** 2), score: 1, reasons: 1 };
  const logits = new Float32Array(AI_PATCH_SIDE ** 2 * 2).fill(-20);
  for (const [px, py, action, value = 8] of edits) logits[(action === 'remove' ? AI_PATCH_SIDE ** 2 : 0) + (py - y) * AI_PATCH_SIDE + px - x] = value;
  return { patch, logits };
}

describe('bounded candidate masks', () => {
  it('ranks actual small components and true broken endpoints, preserving palette and pixels', () => {
    const image = blank(); dot(image, 11, 11, 2); hline(image, 20, 25, 24); hline(image, 27, 30, 24);
    const original = image.pixels.slice();
    const first = generateAiPatches(image, options), second = generateAiPatches(image, options);
    expect(first).toEqual(second);
    expect(first.patches.some(p => p.color === 1 && p.reasons & 2)).toBe(true);
    expect(first.patches.some(p => p.color === 2 && p.reasons & 1)).toBe(true);
    for (const p of first.patches) { expect(p.mask).toHaveLength(4096); expect(p.mask.every(v => v === 0 || v === 1)).toBe(true); }
    expect(image.pixels).toEqual(original);
  });
  it('reports sampled and selected coverage honestly, including a zero budget', () => {
    const image = blank(128, 128);
    for (let y = 4; y < 128; y += 8) for (let x = 4; x < 128; x += 8) dot(image, x, y);
    const result = generateAiPatches(image, options, { maxPatches: 2, maxScannedPixels: 16000 });
    expect(result.patches).toHaveLength(2); expect(result.coverage.scannedPixels).toBe(16000);
    expect(result.coverage.inferredCorePixels).toBeLessThanOrEqual(2048); expect(result.coverage.limited).toBe(true);
    expect(result.coverage.eligiblePatches).toBeGreaterThan(2);
    expect(generateAiPatches(image, options, { maxPatches: 0, maxScannedPixels: 0 }).coverage).toMatchObject({ scannedPixels: 0, selectedPatches: 0, candidatePixels: 0, limited: true });
    expect(() => generateAiPatches(image, options, { maxPatches: 129 })).toThrow(/budget/);
  });
  it('wraps mask halos only on explicitly repeating edges', () => {
    const image = blank(); dot(image, 2, 10); dot(image, 63, 10);
    const repeated = generateAiPatches(image, { ...options, repeatX: true });
    const p = repeated.patches.find(p => p.color === 1 && p.x === -16)!;
    expect(p).toBeDefined(); expect(p.mask[(10 - p.y) * 64 + 15]).toBe(1);
    const plain = generateAiPatches(image, options).patches.find(p => p.color === 1 && p.x === -16)!;
    expect(plain.mask[(10 - plain.y) * 64 + 15]).toBe(0);
    expect(generateAiPatches(image, { ...options, protectedColors: [1] }).patches.every(p => p.color !== 1)).toBe(true);
  });
  it('does not rank truncated fragments of one large solid region as specks', () => {
    const image = blank(128, 128);
    expect(generateAiPatches(image, options).coverage.eligiblePatches).toBe(0);
  });
});

describe('learned proposal application on a frozen canvas', () => {
  it('fills a real three-pixel source gap without requiring the original PNG path', () => {
    const image = blank(); hline(image, 6, 12, 20); hline(image, 16, 23, 20);
    const before = image.pixels.slice(), palette = structuredClone(image.palette);
    const model = prediction(image, 1, [[13, 20, 'add'], [14, 20, 'add'], [15, 20, 'add']]);
    const result = applyAiPredictions(image, options, [model], thresholds);
    expect(result.stats.addedPixels).toBe(3); expect(result.stats.removedPixels).toBe(0);
    expect(result.changes[20 * 64 + 14]).toBe(2);
    expect([13, 14, 15].map(x => result.image.pixels[20 * 64 + x])).toEqual([1, 1, 1]);
    expect(image.pixels).toEqual(before); expect(result.image.palette).toEqual(palette);
    expect(result.image.pixels).not.toBe(image.pixels);
  });
  it('does not bridge parallel contours or cut a crossing third ink', () => {
    const parallel = blank();
    for (let y = 8; y < 26; y++) { dot(parallel, 12, y); dot(parallel, 14, y); }
    expect(applyAiPredictions(parallel, options, [prediction(parallel, 1, [[13, 18, 'add']])], thresholds).stats.addedPixels).toBe(0);
    const crossing = blank(); hline(crossing, 6, 12, 20); hline(crossing, 14, 23, 20);
    for (let y = 14; y < 26; y++) dot(crossing, 13, y, 2);
    expect(applyAiPredictions(crossing, options, [prediction(crossing, 1, [[13, 20, 'add']])], thresholds).stats.addedPixels).toBe(0);
  });
  it('removes an isolated fragment only when the whole component is confidently predicted', () => {
    const image = blank(); dot(image, 14, 12); dot(image, 15, 12);
    const one = prediction(image, 1, [[14, 12, 'remove']]);
    expect(applyAiPredictions(image, options, [one], thresholds).stats.removedPixels).toBe(0);
    const both = prediction(image, 1, [[14, 12, 'remove'], [15, 12, 'remove']]);
    const result = applyAiPredictions(image, options, [both], thresholds);
    expect(result.stats.removedPixels).toBe(2); expect(result.image.pixels[12 * 64 + 14]).toBe(0);
  });
  it('keeps protected inks unchanged and never expands a protected replacement ink', () => {
    const image = blank(); dot(image, 14, 12);
    const removal = prediction(image, 1, [[14, 12, 'remove']]);
    expect(applyAiPredictions(image, { ...options, protectedColors: [1] }, [removal], thresholds).image.pixels).toEqual(image.pixels);
    expect(applyAiPredictions(image, { ...options, protectedColors: [0] }, [removal], thresholds).image.pixels).toEqual(image.pixels);
    hline(image, 6, 12, 20); hline(image, 14, 23, 20);
    expect(applyAiPredictions(image, { ...options, protectedColors: [0] }, [prediction(image, 1, [[13, 20, 'add']])], thresholds).stats.addedPixels).toBe(0);
  });
  it('retains closed ring contours, enclosed centers, compact dots, and continuous strokes', () => {
    const image = blank(), removals: Array<[number, number, 'remove']> = [];
    for (const [x, y] of [[12, 10], [13, 11], [12, 12], [11, 11]]) { dot(image, x, y); removals.push([x, y, 'remove']); }
    const ring = applyAiPredictions(image, options, [prediction(image, 1, removals), prediction(image, 1, [[12, 11, 'add']])], thresholds);
    expect(ring.image.pixels).toEqual(image.pixels);
    for (let y = 20; y < 22; y++) for (let x = 20; x < 22; x++) dot(image, x, y, 2);
    const dotEdits: Array<[number, number, 'remove']> = [[20, 20, 'remove'], [21, 20, 'remove'], [20, 21, 'remove'], [21, 21, 'remove']];
    expect(applyAiPredictions(image, options, [prediction(image, 2, dotEdits)], thresholds).stats.removedPixels).toBe(0);
    hline(image, 4, 26, 28);
    expect(applyAiPredictions(image, options, [prediction(image, 1, [[15, 28, 'remove']])], thresholds).stats.removedPixels).toBe(0);
  });
  it('resolves competing colors deterministically without cascading', () => {
    const image = blank(); hline(image, 7, 14, 16); hline(image, 18, 25, 16);
    for (let y = 7; y <= 14; y++) dot(image, 16, y, 2);
    for (let y = 18; y <= 25; y++) dot(image, 16, y, 2);
    const a = prediction(image, 1, [[16, 16, 'add', 5]]), b = prediction(image, 2, [[16, 16, 'add', 5]]);
    const first = applyAiPredictions(image, options, [a, b], thresholds), second = applyAiPredictions(image, options, [b, a], thresholds);
    expect(first.stats.conflictPixels).toBe(1); expect(first.stats.addedPixels).toBe(0); expect(first).toEqual(second);
    b.logits[(16 - b.patch.y) * 64 + 16 - b.patch.x] = 3.8;
    const decisive = applyAiPredictions(image, options, [a, b], { ...thresholds, margin: .01 });
    expect(decisive.image.pixels[16 * 64 + 16]).toBe(1);
  });
  it('repairs an explicitly repeating seam, including both sides of the gap', () => {
    const image = blank(); hline(image, 57, 62, 20); hline(image, 1, 7, 20);
    const models = [prediction(image, 1, [[63, 20, 'add']]), prediction(image, 1, [[0, 20, 'add']])];
    expect(applyAiPredictions(image, { ...options, repeatX: true }, models, thresholds).stats.addedPixels).toBe(2);
    expect(applyAiPredictions(image, options, models, thresholds).stats.addedPixels).toBe(0);
  });
  it('declines invalid tensors, low or nonfinite confidence, and exhausted geometry work', () => {
    const image = blank(); hline(image, 6, 12, 20); hline(image, 14, 23, 20);
    const low = prediction(image, 1, [[13, 20, 'add', 0]]);
    expect(applyAiPredictions(image, options, [low], thresholds).stats.addedPixels).toBe(0);
    const model = prediction(image, 1, [[13, 20, 'add']]);
    const limited = applyAiPredictions(image, options, [model], thresholds, { maxGeometryCells: 0 });
    expect(limited.stats.geometryBudgetExhausted).toBe(true); expect(limited.stats.addedPixels).toBe(0);
    model.logits = new Float32Array(2);
    expect(() => applyAiPredictions(image, options, [model], thresholds)).toThrow(/shape/);
    expect(() => applyAiPredictions(image, options, [], { add: 1.01, remove: .5 })).toThrow(/threshold/);
  });
  it('supports a model-card threshold of one to disable an unreliable head', () => {
    const image = blank(); hline(image, 6, 12, 20); hline(image, 14, 23, 20); dot(image, 8, 8);
    const models = [prediction(image, 1, [[13, 20, 'add', 100], [8, 8, 'remove', 100]])];
    const noAdd = applyAiPredictions(image, options, models, { add: 1, remove: .97 });
    expect(noAdd.stats.addedPixels).toBe(0); expect(noAdd.stats.removedPixels).toBe(1);
    const noRemove = applyAiPredictions(image, options, models, { add: .97, remove: 1 });
    expect(noRemove.stats.addedPixels).toBe(1); expect(noRemove.stats.removedPixels).toBe(0);
  });
});
