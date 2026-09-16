import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';
import { cleanRaster } from '../src/engine';
import { decodeBmp, decodePng, encodeBmp, rgbaToIndexed } from '../src/image-codec';
import type { CleanupOptions, CleanupResult, IndexedImage, RGB } from '../src/types';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaults = {
  source: 'D:/J- Sample/SET -02/42482pallu PSD FILE.png',
  sized: 'D:/J- Sample/SET -02/42482pallu  (r96p52) SIZED FILE.bmp',
  reference: 'D:/J- Sample/SET -02/42482pallu (r96p52)COMPLETE FILE.bmp',
};
const argumentsMap = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (flag === '--help') {
    console.log('npm run evaluate -- --source input.png --sized sized.bmp --reference complete.bmp [--width 768 --height 988 --read 96 --pick 52 --out output/evaluation]');
    process.exit(0);
  }
  if (!['--source', '--sized', '--reference', '--width', '--height', '--read', '--pick', '--out'].includes(flag) || !process.argv[i + 1]) {
    throw new Error(`Unknown or incomplete option: ${flag}. Use --help for usage.`);
  }
  argumentsMap.set(flag.slice(2), process.argv[i + 1]);
}

const hex = (rgb: RGB) => '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('');
const rgbKey = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
const escapeHtml = (value: string) => value.replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
function equalBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
function rgbDifference(a: IndexedImage, b: IndexedImage): number | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  let different = 0;
  const aKeys = a.palette.map(c => rgbKey(...c));
  const bKeys = b.palette.map(c => rgbKey(...c));
  for (let i = 0; i < a.pixels.length; i++) if (aKeys[a.pixels[i]] !== bKeys[b.pixels[i]]) different++;
  return different;
}
function pngToIndexed(buffer: Buffer): IndexedImage {
  const png = PNG.sync.read(buffer);
  const palette: RGB[] = [];
  const map = new Map<number, number>();
  const pixels = new Uint8Array(png.width * png.height);
  for (let i = 0; i < pixels.length; i++) {
    const offset = i * 4;
    if (png.data[offset + 3] !== 255) throw new Error('Evaluation requires an opaque source PNG, so transparency handling cannot hide a baseline mismatch.');
    const color: RGB = [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
    const key = rgbKey(...color);
    let id = map.get(key);
    if (id === undefined) {
      id = palette.length;
      if (id >= 256) throw new Error('Evaluation requires <=256 exact source colors. Quantize the source explicitly before using this comparison script.');
      map.set(key, id);
      palette.push(color);
    }
    pixels[i] = id;
  }
  return { width: png.width, height: png.height, palette, pixels };
}
function pngBuffer(image: IndexedImage, changeMask?: Uint8Array): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  for (let i = 0; i < image.pixels.length; i++) {
    const color = image.palette[image.pixels[i]];
    const offset = i * 4;
    if (!changeMask) {
      png.data[offset] = color[0]; png.data[offset + 1] = color[1]; png.data[offset + 2] = color[2];
    } else if (changeMask[i]) {
      png.data[offset] = 255; png.data[offset + 1] = 77; png.data[offset + 2] = 137;
    } else {
      const grey = Math.round((color[0] + color[1] + color[2]) / 3 * .25 + 15);
      png.data[offset] = grey; png.data[offset + 1] = grey; png.data[offset + 2] = grey;
    }
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}
function imageStatistics(image: IndexedImage) {
  const { width, height, pixels, palette } = image;
  const perColor = palette.map(color => ({ color: hex(color), area: 0, singleton8: 0, components8: 0, smallComponents2to4: 0, smallComponents5to16: 0 }));
  for (let i = 0; i < pixels.length; i++) perColor[pixels[i]].area++;
  const visited = new Uint8Array(pixels.length);
  const queue = new Int32Array(pixels.length);
  let components8 = 0, singleton8 = 0;
  for (let seed = 0; seed < pixels.length; seed++) {
    if (visited[seed]) continue;
    const color = pixels[seed];
    let read = 0, end = 1;
    queue[0] = seed; visited[seed] = 1;
    while (read < end) {
      const i = queue[read++], x = i % width, y = Math.floor(i / width);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          const next = yy * width + xx;
          if (!visited[next] && pixels[next] === color) { visited[next] = 1; queue[end++] = next; }
        }
      }
    }
    components8++; perColor[color].components8++;
    if (end === 1) { singleton8++; perColor[color].singleton8++; }
    if (end >= 2 && end <= 4) perColor[color].smallComponents2to4++;
    if (end >= 5 && end <= 16) perColor[color].smallComponents5to16++;
  }
  return { width, height, pixels: pixels.length, usedColors: perColor.filter(c => c.area > 0).length, components8, singleton8, perColor };
}
function fingerprint(image: IndexedImage) {
  return createHash('sha256').update(JSON.stringify([image.width, image.height, image.palette])).update(image.pixels).digest('hex');
}
function numericFlag(name: string, fallback: number) {
  const result = Number(argumentsMap.get(name) ?? fallback);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`--${name} must be positive.`);
  return result;
}
function contactSheet(baseline: IndexedImage, cleaned: IndexedImage, changeMask: Uint8Array) {
  // Three fixed, disclosed relative crops: upper border/medallion, dancer outline,
  // and lower instruments. They are representative samples, not worst-case mining.
  const crops = [
    { label: 'Upper ornament', x: .13, y: .025, w: .20, h: .15 },
    { label: 'Dancer outline and texture', x: .37, y: .35, w: .20, h: .15 },
    { label: 'Lower instruments and thin lines', x: .37, y: .70, w: .20, h: .15 },
  ];
  const cw = Math.max(1, Math.floor(baseline.width * .20));
  const ch = Math.max(1, Math.floor(baseline.height * .15));
  const scale = Math.max(1, Math.min(4, Math.floor(500 / cw)));
  const gutter = 12;
  const sheet = new PNG({ width: cw * scale * 3 + gutter * 4, height: ch * scale * crops.length + gutter * (crops.length + 1) });
  sheet.data.fill(20);
  for (let i = 3; i < sheet.data.length; i += 4) sheet.data[i] = 255;
  const baselinePng = PNG.sync.read(pngBuffer(baseline));
  const cleanedPng = PNG.sync.read(pngBuffer(cleaned));
  const deltaPng = PNG.sync.read(pngBuffer(baseline, changeMask));
  for (let row = 0; row < crops.length; row++) {
    const crop = crops[row];
    const left = Math.min(baseline.width - cw, Math.floor(crop.x * baseline.width));
    const top = Math.min(baseline.height - ch, Math.floor(crop.y * baseline.height));
    [baselinePng, cleanedPng, deltaPng].forEach((input, col) => {
      for (let y = 0; y < ch * scale; y++) for (let x = 0; x < cw * scale; x++) {
        const src = ((top + Math.floor(y / scale)) * input.width + left + Math.floor(x / scale)) * 4;
        const dst = ((gutter + row * (ch * scale + gutter) + y) * sheet.width + gutter + col * (cw * scale + gutter) + x) * 4;
        for (let c = 0; c < 4; c++) sheet.data[dst + c] = input.data[src + c];
      }
    });
  }
  return { png: PNG.sync.write(sheet), crops, scale };
}

async function main() {
  const files = {
    source: path.resolve(argumentsMap.get('source') ?? defaults.source),
    sized: path.resolve(argumentsMap.get('sized') ?? defaults.sized),
    reference: path.resolve(argumentsMap.get('reference') ?? defaults.reference),
  };
  const out = path.resolve(argumentsMap.get('out') ?? path.join(project, 'output', 'evaluation'));
  const [sourceBytes, sizedBytes, referenceBytes] = await Promise.all([readFile(files.source), readFile(files.sized), readFile(files.reference)]);
  const source = pngToIndexed(sourceBytes);
  const browserDecoded = await decodePng(sourceBytes);
  const browserIndexed = rgbaToIndexed(browserDecoded);
  const browserSourceRgbMismatch = rgbDifference(source, browserIndexed);
  const sized = decodeBmp(sizedBytes);
  const reference = decodeBmp(referenceBytes);
  const originalFingerprint = fingerprint(source);
  const width = numericFlag('width', sized.width), height = numericFlag('height', sized.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('Output width and height must be integers.');
  const read = numericFlag('read', 96), pick = numericFlag('pick', 52);
  const outlineColor = source.palette.reduce((best, color, i) => color.reduce((sum, c) => sum + c, 0) < source.palette[best].reduce((sum, c) => sum + c, 0) ? i : best, 0);
  const sizedStats = imageStatistics(sized), referenceStats = imageStatistics(reference);
  const referenceUsedColors = referenceStats.perColor.filter(color => color.area > 0).map(color => color.color).sort();
  const sourceColorsTruncatedToFiveBits = [...new Set(source.palette.map(color => hex(color.map(channel => channel & 248) as RGB)))].sort();
  await mkdir(out, { recursive: true });
  const variants: {
    id: string; options: CleanupOptions; elapsedMs: number; stats: CleanupResult['stats']; warnings: string[];
    measured: ReturnType<typeof imageStatistics>; changedPixels: number; changedFraction: number;
    colorAreaDeltas: { color: string; before: number; after: number; delta: number }[];
    checks: { dimensions: boolean; exactPalette: boolean; validIndices: boolean; bmpRoundTrip: boolean; baselineRgbMismatchVsSized: number | null; changeMaskMatchesPixels: boolean; inputUnchanged: boolean };
  }[] = [];
  let baselineImage: IndexedImage | undefined;
  let baselineStats: ReturnType<typeof imageStatistics> | undefined;
  let selected: CleanupResult | undefined;
  // This is a conservative candidate for human review, not an automated accuracy winner.
  const selectedId = 'balanced-texture';
  let deterministic = false;
  let contactMeta: { crops: ReturnType<typeof contactSheet>['crops']; scale: number } | undefined;
  for (const strength of ['gentle', 'balanced', 'strong'] as const) {
    for (const flattenTexture of [false, true]) {
      const id = `${strength}-${flattenTexture ? 'texture' : 'detail'}`;
      const options: CleanupOptions = { width, height, read, pick, strength, flattenTexture, outlineColor, protectedColors: [], repeatX: false, repeatY: false };
      console.log(`Evaluating ${id} at ${width} x ${height}...`);
      const start = performance.now();
      const result = await cleanRaster(source, options);
      const elapsedMs = Math.round(performance.now() - start);
      const baseline: IndexedImage = { width, height, pixels: result.baseline, palette: source.palette };
      baselineImage ??= baseline;
      baselineStats ??= imageStatistics(baseline);
      const measured = imageStatistics(result.image);
      const encoded = encodeBmp(result.image, read, pick);
      const decoded = decodeBmp(encoded);
      let changedPixels = 0, changeMaskMatchesPixels = result.changes.length === result.image.pixels.length;
      for (let i = 0; i < result.image.pixels.length; i++) {
        const changed = result.image.pixels[i] !== result.baseline[i];
        if (changed) changedPixels++;
        if (Boolean(result.changes[i]) !== changed) changeMaskMatchesPixels = false;
      }
      const colorAreaDeltas = source.palette.map((color, i) => ({ color: hex(color), before: baselineStats!.perColor[i].area, after: measured.perColor[i]?.area ?? 0, delta: (measured.perColor[i]?.area ?? 0) - baselineStats!.perColor[i].area }));
      const checks = {
        dimensions: result.image.width === width && result.image.height === height && result.image.pixels.length === width * height,
        exactPalette: JSON.stringify(result.image.palette) === JSON.stringify(source.palette),
        validIndices: result.image.pixels.every(pixel => pixel < result.image.palette.length),
        bmpRoundTrip: rgbDifference(decoded, result.image) === 0,
        baselineRgbMismatchVsSized: rgbDifference(baseline, sized),
        changeMaskMatchesPixels,
        inputUnchanged: fingerprint(source) === originalFingerprint,
      };
      variants.push({ id, options, elapsedMs, stats: result.stats, warnings: result.warnings, measured, changedPixels, changedFraction: changedPixels / result.image.pixels.length, colorAreaDeltas, checks });
      const sheet = contactSheet(baseline, result.image, result.changes);
      await Promise.all([
        writeFile(path.join(out, `${id}.png`), pngBuffer(result.image)),
        writeFile(path.join(out, `${id}.bmp`), encoded),
        writeFile(path.join(out, `${id}-delta.png`), pngBuffer(baseline, result.changes)),
        writeFile(path.join(out, `${id}-contact-sheet.png`), sheet.png),
      ]);
      if (id === selectedId) {
        selected = result;
        contactMeta = { crops: sheet.crops, scale: sheet.scale };
        const repeated = await cleanRaster(source, options);
        deterministic = equalBytes(result.image.pixels, repeated.image.pixels) && equalBytes(result.baseline, repeated.baseline) && equalBytes(result.changes, repeated.changes) && JSON.stringify(result.image.palette) === JSON.stringify(repeated.image.palette);
        await writeFile(path.join(out, 'contact-sheet.png'), sheet.png);
      }
    }
  }
  if (!selected || !baselineImage || !baselineStats) throw new Error('Evaluation failed to produce the selected variant.');
  await Promise.all([
    writeFile(path.join(out, 'baseline.png'), pngBuffer(baselineImage)),
    writeFile(path.join(out, 'cleaned.png'), pngBuffer(selected.image)),
    writeFile(path.join(out, 'delta.png'), pngBuffer(baselineImage, selected.changes)),
    writeFile(path.join(out, 'completed-context.png'), pngBuffer(reference)),
  ]);
  const allChecksPassed = browserSourceRgbMismatch === 0 && deterministic && variants.every(v => v.checks.dimensions && v.checks.exactPalette && v.checks.validIndices && v.checks.bmpRoundTrip && v.checks.changeMaskMatchesPixels && v.checks.inputUnchanged && v.checks.baselineRgbMismatchVsSized === 0);
  const report = {
    generatedAt: new Date().toISOString(), files, source: { width: source.width, height: source.height, palette: source.palette.map(hex), fileSha256: createHash('sha256').update(sourceBytes).digest('hex') },
    browserImportCheck: { independentDecoder: 'pngjs', rgbMismatchPixels: browserSourceRgbMismatch, passed: browserSourceRgbMismatch === 0, dpiX: browserDecoded.dpiX, dpiY: browserDecoded.dpiY },
    target: { width, height, read, pick, outlineColor: hex(source.palette[outlineColor]), outlineSelection: 'Darkest source palette color by RGB sum; review this assumption for other designs.' },
    baseline: baselineStats,
    suppliedSized: { ...sizedStats, bitsPerPixel: sizedBytes.readUInt16LE(28) },
    completedReference: { ...referenceStats, bitsPerPixel: referenceBytes.readUInt16LE(28), role: 'Context only: different dimensions and creative recoloring. Not a per-pixel ground truth; no accuracy score is calculated.', paletteCheck: { usedColors: referenceUsedColors, sourceColorsTruncatedToFiveBits, matchesSourceRgbBitwiseAnd248: JSON.stringify(referenceUsedColors) === JSON.stringify(sourceColorsTruncatedToFiveBits) } },
    variants, selectedPreview: selectedId, deterministicCheck: { variant: selectedId, passed: deterministic }, allChecksPassed, contactSheet: contactMeta,
    limitations: [
      'One design only. These component counts and color-area deltas are descriptive, not accuracy or measured labor savings.',
      'Completed reference includes designer color replacements and may include structural or sizing edits. No direct pixel subtraction or registration is treated as correctness.',
      'Eight-connected singleton reduction alone cannot distinguish noise from intentional one-pixel artwork. Thin lines, holes, ornament details and texture boundaries need human review at loom pixel scale.',
      'Automatic outline selection uses the darkest palette color for this sample. Protected colors and repeating tile edge treatment are disabled for this panel evaluation.',
      'balanced-texture is the preview candidate because the supplied reference flattens texture. It is not an accuracy-selected best mode; compare all contact sheets before approving a preset.',
      'No NedGraphics import, machine-file output, fabric simulation or timed manual-correction trial was performed by this script.',
    ],
  };
  const rows = variants.map(v => `| ${v.id} | ${v.elapsedMs} | ${v.changedPixels.toLocaleString('en-US')} | ${(100 * v.changedFraction).toFixed(2)}% | ${v.measured.singleton8.toLocaleString('en-US')} | ${v.measured.components8.toLocaleString('en-US')} | ${v.checks.bmpRoundTrip ? 'pass' : 'FAIL'} |`).join('\n');
  const md = `# Loom Clean sample evaluation\n\nGenerated ${report.generatedAt}. Run with \`npm run evaluate\`; use \`npm run evaluate -- --help\` for portable file arguments.\n\nSource: ${source.width} × ${source.height}, ${source.palette.length} exact colors. Target: ${width} × ${height}; R${read}/P${pick}.\n\n## Safety and reproducibility\n\n- All required checks: **${allChecksPassed ? 'PASS' : 'FAIL — inspect report.json'}**.\n- Sized-file equality is checked in RGB, independent of palette ordering, for every variant.\n- Original indexed source is fingerprinted before and after each run. Export is decoded and compared in RGB.\n- Determinism: ${deterministic ? 'pass' : 'FAIL'} for ${selectedId}.\n\n## Descriptive measurements\n\n| Variant | Engine ms | Changed pixels | Changed % | Singletons (8-connected) | Components (8-connected) | BMP round trip |\n|---|---:|---:|---:|---:|---:|---|\n${rows}\n\nBaseline singletons: ${baselineStats.singleton8}; supplied completed reference: ${referenceStats.singleton8}. These counts do not measure cleanup accuracy. Per-color component counts and color-area deltas are in report.json. Engine timings exclude PNG encoding and comparison statistics; a second deterministic run is excluded from the selected row.\n\n## Review images\n\nOpen [review.html](review.html) for all variants. [contact-sheet.png](contact-sheet.png) shows **baseline, ${selectedId}, changed pixels** from left to right, at ${contactMeta?.scale}× pixel zoom. Rows show upper ornament, dancer outline/texture, and lower instruments/thin lines. Magenta means a changed pixel, not an error or a success.\n\n- [baseline.png](baseline.png): engine nearest-neighbor baseline.\n- [cleaned.png](cleaned.png): ${selectedId}, a candidate for human review.\n- [delta.png](delta.png): changed-pixel overlay.\n- [completed-context.png](completed-context.png): user-completed design as contextual reference.\n\n## Limitations and next validation\n\n${report.limitations.map(s => `- ${s}`).join('\n')}\n\nNext: have a designer inspect the protected fine motifs and flattened boundaries, time the remaining NedGraphics corrections on several unseen designs, and retain every approved/rejected local change before selecting a production preset.\n`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loom Clean · Sample evaluation</title><style>body{margin:0;background:#0d1518;color:#e9f0ee;font:16px/1.6 system-ui,sans-serif}main{max-width:1480px;margin:auto;padding:32px}h1{font-size:36px}h2{margin-top:40px}p{max-width:90ch;color:#aebfbd}a{color:#77ded2}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{text-align:left;padding:12px;border-bottom:1px solid #2c3e41}section{border:1px solid #304146;padding:20px;margin:24px 0;border-radius:14px}img{max-width:100%;image-rendering:pixelated;display:block;background:#111}figure{margin:0}figcaption{padding:12px 0;color:#aebfbd}.labels{display:grid;grid-template-columns:repeat(3,1fr);text-align:center;color:#aebfbd}.warning{border-left:3px solid #c4a565;padding:8px 20px;background:#1c2527}.full{display:flex;gap:20px;overflow:auto}.full img{max-width:none;max-height:700px;width:auto}</style><main><h1>Loom Clean · Sample evaluation</h1><p>${source.width} × ${source.height} source → ${width} × ${height} output, R${read}/P${pick}; ${source.palette.length} exact colors. <a href="report.json">Complete measured report</a> · <a href="report.md">Readable report</a></p><div class="warning"><strong>${allChecksPassed ? 'All structural and reproducibility checks passed.' : 'A required check failed; inspect report.json.'}</strong><p>One sample; no measured accuracy or manual time saving. The completed design includes recoloring and differs in height, so it is shown only as context. Singletons can be intentional design details. Magenta highlights a changed pixel.</p></div><h2>Candidate modes</h2><table><thead><tr><th>Mode</th><th>Engine ms</th><th>Changed pixels</th><th>8-connected singletons</th><th>Export</th></tr></thead><tbody>${variants.map(v => `<tr><td><a href="#${v.id}">${v.id}</a></td><td>${v.elapsedMs}</td><td>${v.changedPixels.toLocaleString('en-US')} (${(v.changedFraction * 100).toFixed(2)}%)</td><td>${v.measured.singleton8}</td><td><a href="${v.id}.bmp">BMP</a></td></tr>`).join('')}</tbody></table>${variants.map(v => `<section id="${v.id}"><h2>${v.id}${v.id === selectedId ? ' · default preview candidate' : ''}</h2><p>Rows: upper ornament; dancer outline and texture; lower instruments and thin lines. Fixed relative crop positions at ${contactMeta?.scale}× pixel zoom. <a href="${v.id}.png">Full cleaned PNG</a> · <a href="${v.id}-delta.png">Full change overlay</a></p><div class="labels"><span>Sized baseline</span><span>Cleaned candidate</span><span>Changed pixels</span></div><figure><img src="${v.id}-contact-sheet.png" alt="${v.id} baseline, cleaned output and changed pixel crops"><figcaption>${escapeHtml(v.warnings.join(' ') || 'No engine warnings. Visual approval is still required.')}</figcaption></figure></section>`).join('')}<h2>Completed reference · context only</h2><p>${reference.width} × ${reference.height}; no pixel accuracy comparison is made. Colored areas include human design decisions outside automatic cleanup scope.</p><div class="full"><figure><img src="baseline.png" alt="Sized baseline"><figcaption>Sized baseline</figcaption></figure><figure><img src="cleaned.png" alt="Selected candidate"><figcaption>${selectedId}</figcaption></figure><figure><img src="completed-context.png" alt="User completed reference"><figcaption>Human completed reference</figcaption></figure></div></main></html>`;
  await Promise.all([writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'), writeFile(path.join(out, 'report.md'), md), writeFile(path.join(out, 'review.html'), html)]);
  console.log(`Evaluation ${allChecksPassed ? 'passed structural checks' : 'FAILED one or more checks'}: ${path.join(out, 'report.md')}`);
  console.log(`Visual review: ${path.join(out, 'review.html')}`);
  if (!allChecksPassed) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
