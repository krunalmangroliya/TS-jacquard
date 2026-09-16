import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import * as ort from 'onnxruntime-web/wasm';
import { applyAiPredictions, generateAiPatches, type AiPrediction } from '../src/ai-proposals';
import { parseAiModelCard, verifyModelBytes } from '../src/ai-model';
import { decodeBmp, encodeBmp } from '../src/image-codec';
import type { CleanupOptions, IndexedImage, RGB } from '../src/types';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const argument = (key: string) => process.argv.find(v => v.startsWith(`--${key}=`))?.slice(key.length + 3);
const only = argument('only'), maxPatches = Number(argument('max-patches') ?? 32);
const output = path.resolve(root, argument('out') ?? 'output/ai-experiment');
const hex = (c: RGB) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fingerprint = (image: IndexedImage) => createHash('sha256').update(JSON.stringify([image.width, image.height, image.palette])).update(image.pixels).digest('hex');
const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type Crop = { x: number; y: number; w: number; h: number; label: string; changed?: number };
type Sample = { id: string; settings: { width: number; height: number; read: number; pick: number; outlineColor: string; repeatX: boolean; repeatY: boolean }; crops: Crop[] };
const fixed: Record<string, Crop[]> = {
  '45842-daman': [
    { x: 480, y: 216, w: 144, h: 112, label: 'Fixed detail: pale parallel wavy hatching' },
    { x: 720, y: 144, w: 144, h: 112, label: 'Fixed detail: musical instrument grille' },
  ],
  '42482-pallu': [{ x: 284, y: 425, w: 144, h: 112, label: 'Fixed detail: nested skirt ring at x355,y477' }],
};
function rgbEqual(a: IndexedImage, b: IndexedImage): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const ka = a.palette.map(c => (c[0] << 16) | (c[1] << 8) | c[2]), kb = b.palette.map(c => (c[0] << 16) | (c[1] << 8) | c[2]);
  return a.pixels.every((p, i) => ka[p] === kb[b.pixels[i]]);
}
function densest(changes: Uint8Array, width: number, height: number, kind: 0 | 1 | 2): Crop {
  const w = Math.min(144, width), h = Math.min(112, height), stride = width + 1;
  const integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) { const value = changes[y * width + x]; sum += kind ? Number(value === kind) : Number(value !== 0); integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum; }
  }
  let best: Crop = { x: 0, y: 0, w, h, changed: 0, label: kind === 1 ? 'Highest accepted removal density' : kind === 2 ? 'Highest accepted addition density' : 'Highest accepted change density' };
  for (let y = 0; y <= height - h; y += 12) for (let x = 0; x <= width - w; x += 12) {
    const changed = integral[(y + h) * stride + x + w] - integral[y * stride + x + w] - integral[(y + h) * stride + x] + integral[y * stride + x];
    if (changed > best.changed!) best = { ...best, x, y, changed };
  }
  return best;
}
function countCrop(changes: Uint8Array, width: number, height: number, crop: Crop) {
  let additions = 0, removals = 0;
  for (let y = crop.y; y < Math.min(height, crop.y + crop.h); y++) for (let x = crop.x; x < Math.min(width, crop.x + crop.w); x++) { const kind = changes[y * width + x]; if (kind === 1) removals++; if (kind === 2) additions++; }
  return { additions, removals };
}
function contact(before: IndexedImage, after: IndexedImage, changes: Uint8Array, crops: Crop[]): Buffer {
  const scale = 3, gap = 12, cellWidth = 144, cellHeight = 112;
  const png = new PNG({ width: cellWidth * scale * 3 + gap * 4, height: cellHeight * scale * crops.length + gap * (crops.length + 1) });
  png.data.fill(28); for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  for (let row = 0; row < crops.length; row++) for (let col = 0; col < 3; col++) for (let y = 0; y < cellHeight; y++) for (let x = 0; x < cellWidth; x++) {
    const xx = crops[row].x + x, yy = crops[row].y + y;
    let color: RGB = [28, 28, 28];
    if (xx >= 0 && yy >= 0 && xx < before.width && yy < before.height) {
      const index = yy * before.width + xx, image = col === 0 ? before : after;
      color = image.palette[image.pixels[index]];
      if (col === 2) {
        const gray = Math.round((color[0] + color[1] + color[2]) / 3 * .35);
        color = changes[index] === 1 ? [235, 93, 186] : changes[index] === 2 ? [126, 234, 124] : [gray, gray, gray];
      }
    }
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = ((gap + row * (cellHeight * scale + gap) + y * scale + dy) * png.width + gap + col * (cellWidth * scale + gap) + x * scale + dx) * 4;
      png.data[i] = color[0]; png.data[i + 1] = color[1]; png.data[i + 2] = color[2]; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function main() {
  if (!Number.isInteger(maxPatches) || maxPatches < 1 || maxPatches > 128) throw new Error('Use --max-patches=1..128.');
  await mkdir(output, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, 'output/sample-analysis/manifest.json'), 'utf8')) as { generatedAt: string; samples: Sample[] };
  const v2 = JSON.parse(await readFile(path.join(root, 'output/sample-analysis/v2-full-report.json'), 'utf8')) as { generatedAt: string; results: Array<{ id: string; input: string; controlledOutlineColor: string }> };
  const samples = manifest.samples.filter(s => !only || s.id === only);
  if (!samples.length) throw new Error('No matching sample case.');
  const card = parseAiModelCard(JSON.parse(await readFile(path.join(root, 'public/models/loom-tiny-v1.json'), 'utf8')));
  const bytes = new Uint8Array(await readFile(path.join(root, 'public/models', card.modelFile)));
  await verifyModelBytes(bytes.buffer, card);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { mjs: pathToFileURL(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.mjs')).href };
  ort.env.wasm.wasmBinary = new Uint8Array(await readFile(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'))).buffer;
  const modelStarted = performance.now();
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const modelLoadMs = performance.now() - modelStarted;
  const files = ['src/ai-proposals.ts', 'src/ai-model.ts', 'scripts/evaluate-ai.ts'];
  const codeHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(root, file)))])));
  const results = [], htmlImages: Record<string, string> = {};
  try {
    for (const sample of samples) {
      const inputFile = `${sample.id}-v2-full-source.bmp`, inputBytes = await readFile(path.join(root, 'output/sample-analysis', inputFile));
      const before = decodeBmp(inputBytes), beforeFingerprint = fingerprint(before), beforePalette = JSON.stringify(before.palette);
      const outlineHex = v2.results.find(r => r.id === sample.id && r.input === 'source')?.controlledOutlineColor ?? sample.settings.outlineColor;
      const outlineColor = before.palette.findIndex(c => hex(c) === outlineHex);
      if (outlineColor < 0) throw new Error(`Missing original controlled outline for ${sample.id}.`);
      const options: CleanupOptions = { ...sample.settings, width: before.width, height: before.height, outlineColor, protectedColors: [], strength: 'balanced', flattenTexture: true };
      const start = performance.now(), generated = generateAiPatches(before, options, { maxPatches });
      const candidateMs = performance.now() - start;
      const predictions: AiPrediction[] = [];
      const confidentRemovalMask = new Uint8Array(before.pixels.length);
      const raw = { addAboveThreshold: 0, removeAboveThreshold: 0, nonfinite: 0, minimumLogit: Infinity, maximumLogit: -Infinity };
      const addLogit = Math.log(card.thresholds.add / (1 - card.thresholds.add)), removeLogit = Math.log(card.thresholds.remove / (1 - card.thresholds.remove));
      const inferenceStart = performance.now();
      for (let p = 0; p < generated.patches.length; p++) {
        const patch = generated.patches[p], input = new ort.Tensor('float32', patch.mask, [1, 1, 64, 64]);
        const output = await session.run({ ink: input });
        try {
          const tensor = output.logits;
          if (!tensor || tensor.type !== 'float32' || JSON.stringify(tensor.dims) !== '[1,2,64,64]') throw new Error('Wrong model tensor contract.');
          const logits = new Float32Array(tensor.data as Float32Array);
          for (const value of logits) { if (!Number.isFinite(value)) raw.nonfinite++; else { raw.minimumLogit = Math.min(raw.minimumLogit, value); raw.maximumLogit = Math.max(raw.maximumLogit, value); } }
          for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) {
            const xx = patch.x + x, yy = patch.y + y;
            if (xx < 0 || yy < 0 || xx >= before.width || yy >= before.height) continue;
            const index = yy * before.width + xx, cell = y * 64 + x;
            if (before.pixels[index] === patch.color) {
              const confident = logits[4096 + cell] >= removeLogit;
              raw.removeAboveThreshold += Number(confident);
              if (confident) confidentRemovalMask[index] = 1;
            }
            else raw.addAboveThreshold += Number(logits[cell] >= addLogit);
          }
          predictions.push({ patch, logits });
        } finally { input.dispose(); for (const tensor of Object.values(output)) tensor.dispose(); }
      }
      const inferenceMs = performance.now() - inferenceStart, applyStart = performance.now();
      const applied = applyAiPredictions(before, options, predictions, card.thresholds);
      const applicationMs = performance.now() - applyStart, totalMs = performance.now() - start;
      const encoded = encodeBmp(applied.image, options.read, options.pick), roundTrip = decodeBmp(encoded);
      const changed = applied.stats.addedPixels + applied.stats.removedPixels;
      const checks = {
        dimensions: applied.image.width === before.width && applied.image.height === before.height,
        palette: JSON.stringify(applied.image.palette) === beforePalette,
        validIndices: applied.image.pixels.every(p => p < before.palette.length),
        bmpRgbRoundTrip: rgbEqual(applied.image, roundTrip),
        inputUnchanged: fingerprint(before) === beforeFingerprint,
        changeCountConsistent: applied.image.pixels.reduce((sum, color, i) => sum + Number(color !== before.pixels[i]), 0) === changed,
        finiteModelLogits: raw.nonfinite === 0,
      };
      const crops = [densest(applied.changes, before.width, before.height, 0), { ...densest(confidentRemovalMask, before.width, before.height, 1), label: 'Highest model-confident removal density before geometry guards' }, ...(fixed[sample.id] ?? [])];
      const cropReports = crops.map(c => {
        const inferred = new Set<number>(); let selectedInkPasses = 0;
        for (const patch of generated.patches) {
          const left = Math.max(0, c.x, patch.x + 16), top = Math.max(0, c.y, patch.y + 16);
          const right = Math.min(before.width, c.x + c.w, patch.x + 48), bottom = Math.min(before.height, c.y + c.h, patch.y + 48);
          if (right > left && bottom > top) selectedInkPasses++;
          for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) inferred.add(y * before.width + x);
        }
        return { ...c, ...countCrop(applied.changes, before.width, before.height, c), inferredPixels: inferred.size, selectedInkPasses };
      });
      const png = contact(before, applied.image, applied.changes, crops), outputFile = `${sample.id}-tiny-ai.bmp`, contactFile = `${sample.id}-contact.png`;
      await Promise.all([writeFile(path.join(output, outputFile), encoded), writeFile(path.join(output, contactFile), png)]);
      htmlImages[sample.id] = png.toString('base64');
      const result = { id: sample.id, inputFile, inputSha256: hash(inputBytes), outputFile, outputSha256: hash(encoded), contactFile, width: before.width, height: before.height, options, coverage: generated.coverage, modelPredictions: raw, stats: applied.stats, confidentPixelColorProposalsGated: raw.addAboveThreshold + raw.removeAboveThreshold - changed, timings: { candidateMs, inferenceMs, applicationMs, totalMs }, checks, crops: cropReports, patches: generated.patches.map(({ mask: _mask, ...metadata }) => metadata), paletteBasis: 'Exact palette of the loaded V2 BMP is preserved. BMP reload can omit unused entries or reorder palette indices, so roundtrip checks compare RGB.' };
      results.push(result);
      await writeFile(path.join(output, `${sample.id}.json`), JSON.stringify(result, null, 2));
      console.log(`${sample.id}: ${generated.patches.length} real model patches; confident +${raw.addAboveThreshold}/-${raw.removeAboveThreshold}; accepted +${applied.stats.addedPixels}/-${applied.stats.removedPixels}; ${totalMs.toFixed(0)} ms; checks ${Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'}`);
    }
  } finally { await session.release(); }
  const report = { generatedAt: new Date().toISOString(), provider: 'onnxruntime-web/wasm, CPU, 1 thread, local files', model: card, modelLoadMs, maxPatches, codeHashes, datasetManifestGeneratedAt: manifest.generatedAt, v2BaselinesGeneratedAt: v2.generatedAt, results, allChecksPassed: results.every(r => Object.values(r.checks).every(Boolean)), qualification: 'Actual ONNX predictions on the 10 supplied V2 source baselines. Synthetic training/validation is not proof of real-artwork accuracy. The same supplied designs may be present in training; this is an integration and visual review, not an independent held-out benchmark. Confidence counts are candidate pixel-color proposals; accepted edits pass geometry guards. Fixed details outside selected cores have not been inspected by the model. No saved-time or accuracy claim is supported.' };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const table = results.map(r => `<tr><td><a href="#${escape(r.id)}">${escape(r.id)}</a></td><td>${r.width}×${r.height}</td><td>${r.coverage.selectedPatches}/${r.coverage.eligiblePatches}</td><td>${(100 * r.coverage.candidatePixels / r.coverage.totalPixels).toFixed(2)}%</td><td>+${r.modelPredictions.addAboveThreshold} / −${r.modelPredictions.removeAboveThreshold}</td><td>+${r.stats.addedPixels} / −${r.stats.removedPixels}</td><td>${(r.timings.totalMs / 1000).toFixed(2)}s</td><td>${Object.values(r.checks).every(Boolean) ? 'PASS' : 'FAIL'}</td></tr>`).join('');
  const sections = results.map(r => `<section id="${escape(r.id)}"><h2>${escape(r.id)}</h2><p>Columns: <b>V2 baseline</b> · <b>after actual tiny model + guards</b> · <b>accepted changes</b> (pink removal, green addition).</p><ol>${r.crops.map(c => `<li>${escape(c.label)} — x${c.x}, y${c.y}, ${c.w}×${c.h}; +${c.additions} / −${c.removals}; ${c.inferredPixels}/${c.w * c.h} pixels inside selected cores (${c.selectedInkPasses} ink passes)</li>`).join('')}</ol><img alt="${escape(r.id)} baseline and AI review crops" src="data:image/png;base64,${htmlImages[r.id]}"><details><summary>Coverage and application diagnostics</summary><pre>${escape(JSON.stringify({ coverage: r.coverage, model: r.modelPredictions, stats: r.stats, checks: r.checks }, null, 2))}</pre></details></section>`).join('');
  await writeFile(path.join(output, 'review.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loom Clean · Tiny AI experiment</title><style>body{margin:0 auto;max-width:1400px;padding:32px;font:15px system-ui;background:#151913;color:#e7e8dd}h1{font-size:28px}p{line-height:1.6;max-width:1150px}.notice{padding:20px;background:#32382a;border-left:4px solid #d1a568}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:12px;border-bottom:1px solid #465039}a{color:#c5dda5}section{margin:56px 0;scroll-margin-top:20px}img{max-width:100%;height:auto;image-rendering:pixelated}pre{overflow:auto;background:#23291e;padding:16px}li{margin:8px 0}small{color:#b0b7a4}</style><h1>Loom Clean: actual tiny-model trial</h1><p class="notice">${escape(report.qualification)}</p><p>${escape(card.name)} · ${card.parameters.toLocaleString()} parameters · ${(card.bytes / 1024).toFixed(0)} KiB · add ${card.thresholds.add}, remove ${card.thresholds.remove}. SHA-256: <small>${card.sha256}</small>. Model load ${(modelLoadMs / 1000).toFixed(2)}s, excluded from per-case timings. One shared CPU WASM session.</p><table><thead><tr><th>Case</th><th>Grid</th><th>Selected / eligible</th><th>Core coverage</th><th>Confident proposals</th><th>Accepted edits</th><th>Time</th><th>Invariants</th></tr></thead><tbody>${table}</tbody></table>${sections}</html>`);
  if (!report.allChecksPassed) throw new Error('At least one image invariant failed; see report.json.');
  console.log(`Completed ${results.length} cases. Report: ${path.join(output, 'review.html')}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
