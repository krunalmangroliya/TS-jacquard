import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { decodeBmp, decodePng, rgbaToIndexed, encodeBmp } from '../src/image-codec';
import { cleanGrainRegions } from '../src/texture-cleanup';
import { cleanRaster } from '../src/engine';
import type { CleanupOptions, IndexedImage, RGB } from '../src/types';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(project, 'output', 'sample-analysis');
const stage = process.argv.includes('--full') ? 'full' : 'noise';
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const hex = (c: RGB) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const fingerprint = (image: IndexedImage) => createHash('sha256').update(JSON.stringify([image.width, image.height, image.palette])).update(image.pixels).digest('hex');
type Case = { id: string; files: { source: string; sized: string; reference: string }; settings: { width: number; height: number; read: number; pick: number }; v1Baselines: { input: 'source' | 'sized'; file: string; settings: { outlineColor: string }; warning: string | null }[]; crops: { label: string; x: number; y: number; w: number; h: number; count: number }[]; pairComparison: { offset: { dx: number; dy: number; maskMeanIoU: number } | null; referenceOrientation?: { clockwiseDegrees: number; mirroredHorizontally: boolean } }; sourceResizeLineage: { best: { mismatchPixels: number; clockwiseDegrees: number; mirroredHorizontally: boolean } }; warnings: string[] };
const manualRegions: Record<string, Case['crops']> = {
  '45842-daman': [
    { x: 264, y: 0, w: 144, h: 112, count: 0, label: 'Fixed review: added pixels joining wavy channels' },
    { x: 480, y: 216, w: 144, h: 112, count: 0, label: 'Fixed review: pale parallel wavy hatching must survive' },
    { x: 720, y: 144, w: 144, h: 112, count: 0, label: 'Fixed review: instrument grille must retain its complete lattice' },
  ],
  '42482-pallu': [
    { x: 284, y: 425, w: 144, h: 112, count: 0, label: 'Fixed review: nested skirt ring center at x355,y477 must survive' },
    { x: 284, y: 345, w: 144, h: 112, count: 0, label: 'Fixed review: dancer face and thin ornaments' },
  ],
  '45842-pallu': [
    { x: 120, y: 240, w: 144, h: 112, count: 0, label: 'Fixed review: dense gold/navy grain behind ornament' },
    { x: 528, y: 336, w: 144, h: 112, count: 0, label: 'Fixed review: grain near face and facial outlines' },
  ],
};
function alignReferenceOrientation(image: IndexedImage, orientation: Case['pairComparison']['referenceOrientation']) {
  if (!orientation || !orientation.clockwiseDegrees && !orientation.mirroredHorizontally) return image;
  const pixels = new Uint8Array(image.pixels.length);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const xx = orientation.mirroredHorizontally ? image.width - 1 - x : x, sx = orientation.clockwiseDegrees === 180 ? image.width - 1 - xx : xx, sy = orientation.clockwiseDegrees === 180 ? image.height - 1 - y : y;
    pixels[y * image.width + x] = image.pixels[sy * image.width + sx];
  }
  return { ...image, pixels };
}
function resizeBaseline(source: IndexedImage, width: number, height: number): IndexedImage {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(source.width - 1, Math.floor((x + .5) * source.width / width)), sy = Math.min(source.height - 1, Math.floor((y + .5) * source.height / height));
    pixels[y * width + x] = source.pixels[sy * source.width + sx];
  }
  return { width, height, pixels, palette: source.palette };
}
function metrics(image: IndexedImage) {
  const counts = new Uint32Array(image.palette.length), singles = new Uint32Array(image.palette.length);
  for (let i = 0; i < image.pixels.length; i++) {
    const color = image.pixels[i], x = i % image.width, y = Math.floor(i / image.width); counts[color]++; let neighbor = false;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(image.height - 1, y + 1) && !neighbor; yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(image.width - 1, x + 1); xx++) { const j = yy * image.width + xx; if (j !== i && image.pixels[j] === color) { neighbor = true; break; } }
    if (!neighbor) singles[color]++;
  }
  return { singleton8: singles.reduce((a, b) => a + b, 0), perColor: image.palette.map((c, i) => ({ color: hex(c), pixels: counts[i], singleton8: singles[i] })) };
}
function densest(mask: Uint8Array, w: number, h: number) {
  const cw = Math.min(144, w), ch = Math.min(112, h), stride = w + 1, integral = new Uint32Array(stride * (h + 1));
  for (let y = 0; y < h; y++) { let sum = 0; for (let x = 0; x < w; x++) { sum += mask[y * w + x]; integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum; } }
  let best = { x: 0, y: 0, w: cw, h: ch, count: 0, label: 'Highest new-vs-v1 change density (diagnostic selection)' };
  for (let y = 0; y <= h - ch; y += 24) for (let x = 0; x <= w - cw; x += 24) {
    const count = integral[(y + ch) * stride + x + cw] - integral[y * stride + x + cw] - integral[(y + ch) * stride + x] + integral[y * stride + x];
    if (count > best.count) best = { ...best, x, y, count };
  }
  return best;
}
function sheet(sized: IndexedImage, old: IndexedImage, next: IndexedImage, reference: IndexedImage, crops: Case['crops'], offset: Case['pairComparison']['offset']) {
  const scale = 3, gap = 10, cw = crops[0].w, ch = crops[0].h, png = new PNG({ width: cw * scale * 4 + gap * 5, height: ch * scale * crops.length + gap * (crops.length + 1) });
  png.data.fill(20); for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  const images = [sized, old, next, reference];
  for (let row = 0; row < crops.length; row++) for (let col = 0; col < 4; col++) for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    let xx = crops[row].x + x, yy = crops[row].y + y;
    if (col === 3) { if (offset) { xx += offset.dx; yy += offset.dy; } else { xx = Math.floor(xx * reference.width / sized.width); yy = Math.floor(yy * reference.height / sized.height); } }
    const image = images[col], c: RGB = xx < 0 || yy < 0 || xx >= image.width || yy >= image.height ? [30, 30, 30] : image.palette[image.pixels[yy * image.width + xx]];
    for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) { const p = ((gap + row * (ch * scale + gap) + y * scale + sy) * png.width + gap + col * (cw * scale + gap) + x * scale + sx) * 4; png.data[p] = c[0]; png.data[p + 1] = c[1]; png.data[p + 2] = c[2]; png.data[p + 3] = 255; }
  }
  return PNG.sync.write(png);
}

async function main() {
  await mkdir(out, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')) as { generatedAt: string; samples: Case[] };
  const codeFiles = ['scripts/engine-v1.ts', ...(await readdir(path.join(project, 'src'))).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).map(name => `src/${name}`)];
  const codeHashes = Object.fromEntries(await Promise.all(codeFiles.map(async file => [file, await readFile(path.join(project, file)).then(b => createHash('sha256').update(b).digest('hex')).catch(() => 'not present')])));
  const results = [];
  const selectedCases = manifest.samples.filter(s => !only || s.id === only);
  if (!selectedCases.length) throw new Error(`Unknown or empty sample selection: ${only ?? 'all'}. Available IDs: ${manifest.samples.map(s => s.id).join(', ')}`);
  for (const sample of selectedCases) {
    const sized = decodeBmp(await readFile(path.join(project, sample.files.sized))), complete = alignReferenceOrientation(decodeBmp(await readFile(path.join(project, sample.files.reference))), sample.pairComparison.referenceOrientation);
    const source = rgbaToIndexed(await decodePng(await readFile(path.join(project, sample.files.source))));
    for (const frozen of sample.v1Baselines) {
      console.log(`${stage}: ${sample.id} / ${frozen.input}...`);
      const old = decodeBmp(await readFile(path.join(out, frozen.file)));
      const raster = frozen.input === 'source' ? source : sized;
      const inputGrid = frozen.input === 'source' ? resizeBaseline(source, sample.settings.width, sample.settings.height) : sized;
      const base = stage === 'full' ? raster! : old;
      const outlineColor = base.palette.findIndex(c => hex(c) === frozen.settings.outlineColor);
      if (outlineColor < 0) throw new Error(`Missing controlled outline color for ${sample.id}/${frozen.input}.`);
      const options: CleanupOptions = { ...sample.settings, strength: 'balanced', flattenTexture: true, outlineColor, protectedColors: [], repeatX: false, repeatY: false };
      const inputFingerprint = fingerprint(base);
      const start = performance.now();
      let next: IndexedImage, implementationStats: unknown;
      if (stage === 'noise') { const result = cleanGrainRegions(old, options); next = { ...old, pixels: result.pixels }; implementationStats = { removedPixels: result.removedPixels, regions: result.regions }; }
      else { const result = cleanRaster(base, options); next = result.image; implementationStats = result.stats; }
      const elapsedMs = Math.round(performance.now() - start), mask = new Uint8Array(next.pixels.length), addedLineMask = new Uint8Array(next.pixels.length);
      const oldKeys = old.palette.map(hex), newKeys = next.palette.map(hex), oldOutline = oldKeys.indexOf(frozen.settings.outlineColor);
      let changedPixels = 0, outlineAdded = 0, outlineRemoved = 0;
      for (let i = 0; i < next.pixels.length; i++) {
        if (oldKeys[old.pixels[i]] !== newKeys[next.pixels[i]]) { mask[i] = 1; changedPixels++; }
        const oldIsLine = old.pixels[i] === oldOutline, newIsLine = newKeys[next.pixels[i]] === frozen.settings.outlineColor;
        if (!oldIsLine && newIsLine) { outlineAdded++; addedLineMask[i] = 1; } if (oldIsLine && !newIsLine) outlineRemoved++;
      }
      const before = metrics(old), after = metrics(next), file = `${sample.id}-v2-${stage}-${frozen.input}.bmp`, encoded = encodeBmp(next, sample.settings.read, sample.settings.pick), roundTrip = decodeBmp(encoded);
      const roundTripRgb = roundTrip.pixels.every((p, i) => hex(roundTrip.palette[p]) === newKeys[next.pixels[i]]);
      const lineCrop = { ...densest(addedLineMask, next.width, next.height), label: 'Highest new outline-addition density versus frozen V1 (candidate repairs, not approved truth)' };
      const crops = [densest(mask, next.width, next.height), sample.crops[0], lineCrop];
      await Promise.all([writeFile(path.join(out, file), encoded), writeFile(path.join(out, `${sample.id}-v2-${stage}-${frozen.input}-contact.png`), sheet(inputGrid, old, next, complete, crops, sample.pairComparison.offset))]);
      if (manualRegions[sample.id]) await writeFile(path.join(out, `${sample.id}-v2-${stage}-${frozen.input}-manual-review.png`), sheet(inputGrid, old, next, complete, manualRegions[sample.id], sample.pairComparison.offset));
      const result = { id: sample.id, input: frozen.input, file, controlledOutlineColor: frozen.settings.outlineColor, elapsedMs, implementationStats, changedPixelsVsV1: changedPixels, outlineAddedVsV1: outlineAdded, outlineRemovedVsV1: outlineRemoved, before, after, colorAreaDeltas: after.perColor.map(c => ({ color: c.color, delta: c.pixels - (before.perColor.find(b => b.color === c.color)?.pixels ?? 0) })), checks: { dimensions: next.width === old.width && next.height === old.height, palette: JSON.stringify(next.palette) === JSON.stringify(base.palette), validIndices: next.pixels.every(p => p < next.palette.length), bmpRoundTrip: roundTripRgb, inputUnchanged: fingerprint(base) === inputFingerprint }, paletteComparisonBasis: 'Current pipeline input palette, including unused colors. BMP decode can omit unused entries or reorder indices; old-vs-new comparisons therefore use RGB.', crops, warnings: [...sample.warnings, ...(frozen.warning ? [frozen.warning] : [])], qualification: 'Descriptive changes only. Source-vs-sized mismatch, recoloring, global translation limits and high-density crop selection prevent treating agreement as accuracy.' };
      results.push(result);
      Object.assign(result, { manualReviewRegions: manualRegions[sample.id] ?? [] });
      console.log(`${sample.id}/${frozen.input}: ${changedPixels} differences vs v1, lines +${outlineAdded}/-${outlineRemoved}, singleton8 ${before.singleton8}→${after.singleton8}, ${elapsedMs}ms.`);
    }
  }
  const report = { generatedAt: new Date().toISOString(), stage, datasetManifestGeneratedAt: manifest.generatedAt, codeHashes, results, notes: ['noise means frozen v1 output plus cleanGrainRegions only; full means the current cleanRaster pipeline with original controlled input/settings.', 'Both original-PNG and authoritative-sized-raster inputs are evaluated independently. They are not interchangeable when the operator rotated, repeated, recolored or arranged the sized file.', 'Changed-pixel counts, singleton counts and outline additions/removals are descriptive and must not be labeled accuracy or saved manual effort.', 'Each contact sheet shows Sized, V1, V2, Completed. First row is highest new-change density; next rows use the fixed dataset diagnostic crops.', 'Completed is only provisionally shifted; substantial geometry mismatch is shown at relative positions and must not be scored directly.'] };
  const allChecksPassed = results.every(r => Object.values(r.checks).every(Boolean));
  Object.assign(report, { allChecksPassed });
  Object.assign(report, { engineCodeHashes: Object.fromEntries(Object.entries(codeHashes).filter(([file]) => /engine|texture|line|structur|preserv|\/types\.ts$/.test(file))) });
  report.notes[3] = 'Each contact sheet shows the actual input resampled to the output grid, V1, V2, Completed. For source-input cases this first column is the original PNG resampled, not the separately edited supplied sized file. Rows are highest new-change density, fixed input-noise crop, and highest new-outline-addition density. These diagnostic selections are not representative accuracy samples.';
  report.notes[4] = 'Completed is provisionally oriented (mirror/180°) and shifted according to the dataset manifest. Substantial geometry mismatch is shown at relative positions and must not be scored directly.';
  report.notes.push('Residual grain remains in several inspected shaded fields; this evaluation does not establish fully flat finishing or correct preservation of every detail. The fixed hatching, grille and ring regions support targeted regression review only.');
  report.notes.push('Automatic outline selection is a heuristic and can choose a minor accent or background color. Review the palette selection for multicolor outlines; the recorded controlled color is identical for V1 and V2.');
  report.notes.push('No timed NedGraphics correction trial or actual NedGraphics import test was performed by this script. This pipeline uses deterministic image processing, not a trained neural model.');
  await writeFile(path.join(out, `v2-${stage}${only ? `-${only}` : ''}-report.json`), JSON.stringify(report, null, 2) + '\n');
  const html = `<!doctype html><html><meta charset="utf-8"><title>V2 ${stage} evaluation</title><style>body{margin:0;background:#0d1518;color:#ecf3f0;font:16px/1.6 system-ui}main{max-width:1800px;margin:auto;padding:24px}section{border:1px solid #334745;margin:26px 0;padding:20px}img{width:100%;image-rendering:pixelated}.labels{display:grid;grid-template-columns:repeat(4,1fr);text-align:center;color:#b3c9c3}p,li{color:#b3c9c3;max-width:110ch}a{color:#77ded2}</style><main><h1>V2 ${stage} · controlled comparison</h1><p>${report.notes.join(' ')}</p><p><a href="v2-${stage}${only ? `-${only}` : ''}-report.json">Measured JSON report</a></p>${results.map(r => `<section><h2>${r.id} · ${r.input} input</h2><p>${r.changedPixelsVsV1.toLocaleString()} changed pixels versus frozen V1; outline +${r.outlineAddedVsV1}/-${r.outlineRemovedVsV1}; singleton8 ${r.before.singleton8}→${r.after.singleton8}; ${r.elapsedMs} ms. <a href="${r.file}">BMP</a></p>${r.warnings.length ? `<ul>${r.warnings.map(w => `<li>${w}</li>`).join('')}</ul>` : ''}<div class="labels"><span>Supplied sized</span><span>Frozen V1</span><span>V2 ${stage}</span><span>Completed · context</span></div><img src="${r.id}-v2-${stage}-${r.input}-contact.png" alt="${r.id} sized, old, new and contextual completed crops"><ol>${r.crops.map(c => `<li>${c.label}, x${c.x}, y${c.y}, ${c.w}×${c.h}</li>`).join('')}</ol></section>`).join('')}</main></html>`;
  const summary = `<p><strong>Structural checks: ${allChecksPassed ? 'all passed' : 'FAIL — inspect JSON'}.</strong> These counts describe edits; they are not accuracy or saved work.</p><table><thead><tr><th>Sample</th><th>Input</th><th>Changed vs V1</th><th>Outline + / −</th><th>Singletons V1 → V2</th><th>ms</th><th>File</th></tr></thead><tbody>${results.map(r => `<tr><td>${r.id}</td><td>${r.input}</td><td>${r.changedPixelsVsV1.toLocaleString()}</td><td>${r.outlineAddedVsV1} / ${r.outlineRemovedVsV1}</td><td>${r.before.singleton8} → ${r.after.singleton8}</td><td>${r.elapsedMs}</td><td><a href="${r.file}">BMP</a></td></tr>`).join('')}</tbody></table>`;
  const manualAppendix = `<h2>Fixed detail regression regions</h2><p>These regions were selected during visual QA to check hatching, grid and ornament preservation. They do not estimate overall accuracy.</p>${results.filter(r => r.input === 'source' && manualRegions[r.id]).map(r => `<details><summary>${r.id} · fixed detail checks</summary><div class="labels"><span>Actual input</span><span>Frozen V1</span><span>V2</span><span>Completed · context</span></div><img src="${r.id}-v2-${stage}-${r.input}-manual-review.png" alt="${r.id} fixed detail regression regions"><ol>${manualRegions[r.id].map(c => `<li>${c.label}; x${c.x}, y${c.y}, ${c.w}×${c.h}</li>`).join('')}</ol></details>`).join('')}`;
  const review = html.replace('</h1>', `</h1>${summary}`).replace('</main>', `${manualAppendix}</main>`).replace('</style>', 'table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:8px;border-bottom:1px solid #344744}th{color:#91bbb1}</style>').replaceAll('<img ', '<img loading="lazy" decoding="async" ').replaceAll('<span>Supplied sized</span>', '<span>Actual input at output grid</span>');
  await writeFile(path.join(out, `v2-${stage}${only ? `-${only}` : ''}-review.html`), review);
  console.log(`Saved V2 ${stage} comparison for ${results.length} controlled cases.`);
  if (!allChecksPassed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
