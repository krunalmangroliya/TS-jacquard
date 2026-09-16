import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { decodeBmp, decodePng, rgbaToIndexed } from '../src/image-codec';
import { CLEANUP_MEDIA_TYPE, encodeCleanupRequest, decodeCleanupResult } from '../src/cleanup-wire';
import { suggestOutlineColor } from '../src/sample-presets';

const manifest = JSON.parse(await readFile('output/sample-analysis/manifest.json', 'utf8'));
const sample = manifest.samples.find((s: { id: string }) => s.id === '42850-pallu');
const source = rgbaToIndexed(await decodePng(await readFile(sample.files.source)));
const expected = decodeBmp(await readFile('output/sample-analysis/42850-pallu-v2-full-source.bmp'));
const packet = encodeCleanupRequest(source, { ...sample.settings, strength: 'balanced', flattenTexture: true,
  outlineColor: suggestOutlineColor(source), protectedColors: [], repeatX: false, repeatY: false });
const start = performance.now();
const response = await fetch('http://127.0.0.1:4328/__loom_cleanup', {
  method: 'POST', headers: { 'Content-Type': CLEANUP_MEDIA_TYPE, Origin: 'http://127.0.0.1:4328', 'X-Loom-Job': randomUUID() }, body: packet,
});
if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
const result = decodeCleanupResult(await response.arrayBuffer());
let differences = 0;
for (let i = 0; i < result.image.pixels.length; i++) {
  const a = result.image.palette[result.image.pixels[i]], b = expected.palette[expected.pixels[i]];
  if (a.some((v, c) => v !== b[c])) differences++;
}
const report = { sourcePixels: source.pixels.length, width: result.image.width, height: result.image.height,
  elapsedMs: performance.now() - start, differencesFromFrozenBenchmark: differences, stats: result.stats };
await writeFile('output/qa/large-local-endpoint.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (differences || result.image.width !== expected.width || result.image.height !== expected.height) throw new Error('Native large-image result did not match the frozen benchmark.');
