import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { proposeTextureRegions, applyTextureRegions } from '../src/region-proposals';
import { decodeBmp, encodeBmp } from '../src/image-codec';
import type { CleanupOptions, IndexedImage } from '../src/types';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'output/region-experiment');
const only = process.argv.find(v => v.startsWith('--only='))?.slice(7).split(',');
const hex = (c: number[]) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
type Sample = { id: string; files: { reference: string }; settings: { width: number; height: number; read: number; pick: number; outlineColor: string }; pairComparison: { offset: { dx: number; dy: number } | null; referenceOrientation: { clockwiseDegrees: number; mirroredHorizontally: boolean } }; crops: { x: number; y: number; w: number; h: number }[] };
const fixed: Record<string, { x: number; y: number; label: string }[]> = {
  '42482-pallu': [{ x: 144, y: 336, label: 'Dancer background' }, { x: 280, y: 665, label: 'Drum diamond background' }, { x: 284, y: 425, label: 'Skirt ring' }, { x: 284, y: 345, label: 'Face and hair lines' }],
  '45842-daman': [{ x: 480, y: 216, label: 'Parallel hatching' }, { x: 720, y: 144, label: 'Grille' }],
  '45842-pallu': [{ x: 120, y: 240, label: 'Broad grain field' }, { x: 528, y: 336, label: 'Face and grain' }],
};
function detailSheet(before: IndexedImage, after: IndexedImage, reference: IndexedImage, sample: Sample) {
  const crops = fixed[sample.id] || sample.crops.slice(0, 2).map(c => ({ x: c.x, y: c.y, label: 'Dataset diagnostic crop' }));
  const scale = 3, cw = 144, ch = 112, gap = 12;
  const png = new PNG({ width: cw * scale * 4 + gap * 5, height: ch * scale * crops.length + gap * (crops.length + 1) });
  png.data.fill(24); for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  for (let row = 0; row < crops.length; row++) for (let col = 0; col < 4; col++) for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    let xx = crops[row].x + x, yy = crops[row].y + y;
    const image = col === 0 || col === 2 ? before : col === 1 ? after : reference;
    if (col === 3) {
      // Reference study recovered an exact PNG-to-SIZED repeat-origin shift.
      if (sample.id === '42850-pallu') xx = (xx + 1602) % before.width;
      xx += sample.pairComparison.offset?.dx ?? 0;
      const dy = sample.id === '45842-daman' ? row === 0 ? -3 : -89 : sample.id === '42482-pallu' && row === 1 ? 2 : sample.pairComparison.offset?.dy ?? 0;
      yy += dy;
      if (sample.pairComparison.referenceOrientation?.mirroredHorizontally) xx = reference.width - 1 - xx;
      if (sample.pairComparison.referenceOrientation?.clockwiseDegrees === 180) { xx = reference.width - 1 - xx; yy = reference.height - 1 - yy; }
    }
    let rgb = xx < 0 || yy < 0 || xx >= image.width || yy >= image.height ? [24, 24, 24] : image.palette[image.pixels[yy * image.width + xx]];
    if (col === 2 && xx >= 0 && yy >= 0 && xx < before.width && yy < before.height) rgb = before.pixels[yy * before.width + xx] !== after.pixels[yy * before.width + xx] ? [235, 93, 186] : rgb.map(c => Math.round(c * .22));
    for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) { const p = ((gap + row * (ch * scale + gap) + y * scale + sy) * png.width + gap + col * (cw * scale + gap) + x * scale + sx) * 4; png.data[p] = rgb[0]; png.data[p + 1] = rgb[1]; png.data[p + 2] = rgb[2]; }
  }
  return { crops, png: PNG.sync.write(png) };
}
function sheet(before: IndexedImage, after: IndexedImage, reference: IndexedImage, sample: Sample) {
  const cw = 480, ch = Math.ceil(before.height / before.width * cw), gap = 10;
  const png = new PNG({ width: cw * 3 + gap * 4, height: ch + gap * 2 }); png.data.fill(24);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  for (let c = 0; c < 3; c++) for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const image = c === 0 ? before : c === 1 ? after : reference;
    let xx = Math.floor(x * before.width / cw), yy = Math.floor(y * before.height / ch);
    if (c === 2) {
      if (sample.id === '42850-pallu') xx = (xx + 1602) % before.width;
      xx += sample.pairComparison.offset?.dx ?? 0; yy += sample.pairComparison.offset?.dy ?? 0;
      if (sample.pairComparison.referenceOrientation?.mirroredHorizontally) xx = reference.width - 1 - xx;
      if (sample.pairComparison.referenceOrientation?.clockwiseDegrees === 180) { xx = reference.width - 1 - xx; yy = reference.height - 1 - yy; }
    }
    const rgb = xx < 0 || yy < 0 || xx >= image.width || yy >= image.height ? [24, 24, 24] : image.palette[image.pixels[yy * image.width + xx]];
    const i = ((gap + y) * png.width + gap + c * (cw + gap) + x) * 4;
    png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2];
  }
  return PNG.sync.write(png);
}
async function main() {
  await mkdir(out, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, 'output/sample-analysis/manifest.json'), 'utf8')) as { samples: Sample[] };
  const results = [], sections = [];
  for (const sample of manifest.samples.filter(s => !only || only.includes(s.id))) {
    const bytes = await readFile(path.join(root, `output/sample-analysis/${sample.id}-v2-full-source.bmp`)), before = decodeBmp(bytes);
    const reference = decodeBmp(await readFile(path.join(root, sample.files.reference)));
    const original = createHash('sha256').update(before.pixels).digest('hex');
    const options: CleanupOptions = { ...sample.settings, outlineColor: before.palette.findIndex(c => hex(c) === sample.settings.outlineColor), strength: 'balanced', protectedColors: [], flattenTexture: true, repeatX: false, repeatY: false };
    const start = performance.now(), scan = proposeTextureRegions(before, options), scanMs = performance.now() - start, after = applyTextureRegions(before, scan.proposals);
    const encoded = encodeBmp(after, options.read, options.pick), roundtrip = decodeBmp(encoded), keys = after.palette.map(hex), rtkeys = roundtrip.palette.map(hex);
    const changes = after.pixels.reduce((sum, color, i) => sum + Number(color !== before.pixels[i]), 0);
    const detail = detailSheet(before, after, reference, sample), overview = sheet(before, after, reference, sample);
    const result = { id: sample.id, scanMs, scannedPixels: scan.scannedPixels, limited: scan.limited, changes, regions: scan.proposals.map(({ pixelIndices: _indices, replacementColors: _colors, ...p }) => p), crops: detail.crops, checks: { inputUnchanged: createHash('sha256').update(before.pixels).digest('hex') === original, palette: JSON.stringify(after.palette) === JSON.stringify(before.palette), dimensions: after.width === before.width && after.height === before.height, bmpRoundtrip: after.pixels.every((p, i) => keys[p] === rtkeys[roundtrip.pixels[i]]), wholeCanvasScanned: scan.scannedPixels === before.pixels.length, validIndices: after.pixels.every(p => p < after.palette.length), countConsistent: changes === scan.proposals.reduce((n, p) => n + p.removedPixels, 0) } };
    results.push(result);
    await Promise.all([writeFile(path.join(out, `${sample.id}.json`), JSON.stringify(result, null, 2)), writeFile(path.join(out, `${sample.id}-regions.bmp`), encoded), writeFile(path.join(out, `${sample.id}-overview.png`), overview), writeFile(path.join(out, `${sample.id}-detail.png`), detail.png)]);
    sections.push(`<section><h2>${sample.id}</h2><p>${result.regions.length} suggested regions; ${changes.toLocaleString()} proposed pixel changes; ${(scanMs / 1000).toFixed(1)} seconds. <a href="${sample.id}-regions.bmp">BMP proposal</a></p><p>V2 before · region proposal · supplied COMPLETE (context)</p><img src="data:image/png;base64,${overview.toString('base64')}" alt="${sample.id} full comparison"><p>Native detail: V2 before · region proposal · changed pixels · COMPLETE (context)</p><img src="data:image/png;base64,${detail.png.toString('base64')}" alt="${sample.id} native pixel crops"><ol>${detail.crops.map(c => `<li>${c.label}: ${c.x}, ${c.y}</li>`).join('')}</ol></section>`);
    console.log(`${sample.id}: ${result.regions.length} regions, ${changes} pixels, ${scanMs.toFixed(0)}ms`);
  }
  const allChecksPassed = results.every(r => Object.values(r.checks).every(Boolean));
  const qualification = 'Whole-canvas region proposals for per-region designer review, using structural and texture analysis. This is not the earlier tiny speck model. COMPLETE demonstrates the intended flat fields and retained linework even when colors differ. Reference colors are never copied into the proposal. The reference study supplies the exact 1602-column repeat shift for 42850-pallu and local offsets for the daman and pallu detail crops. Full overviews elsewhere still use provisional global alignment; local layout differences remain. Edit counts are not accuracy. Review intended dots, hatch lines, borders and shading before accepting each region.';
  await writeFile(path.join(out, only ? 'selected-report.json' : 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), engineHash: createHash('sha256').update(await readFile(path.join(root, 'src/region-proposals.ts'))).digest('hex'), allChecksPassed, results, qualification }, null, 2));
  await writeFile(path.join(out, only ? `review-${only.join('-')}.html` : 'review.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Whole-region cleanup review</title><style>body{margin:0;background:#171e18;color:#e7eadb;font:16px/1.6 system-ui}main{max-width:1800px;padding:24px;margin:auto}section{margin:40px 0;padding:20px;border:1px solid #50614b}img{width:100%;image-rendering:pixelated}p{max-width:120ch}a{color:#c9e896}</style><main><h1>Whole-region cleanup</h1><p>${qualification}</p><p>File-integrity checks: ${allChecksPassed ? 'passed' : 'FAILED'}.</p>${sections.join('')}</main></html>`);
  if (!allChecksPassed) throw new Error('An image invariant failed.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
