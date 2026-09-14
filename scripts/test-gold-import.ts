import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { prepareTraceInput, importPalette } from '../packages/core/src/input-preprocessing';
import { binarize, traceImage } from '../packages/core/src/trace';
import { buildPlanarMap } from '../packages/core/src/topology';
import { render } from '../packages/core/src/render';
import { encodePng } from '../packages/core/src/png';
import { DEFAULT_PALETTE, type RasterInput } from '../packages/core/src/types';
import { goldFaceColors, traceGoldArtwork } from '../packages/core/src/gold-contours';
import { validateMaster } from '../packages/core/src/schemas';

// Read-only source comparison. Results stay under output, never in the library.
const root = process.cwd(), directory = path.join(root, 'output/gb-import');
await mkdir(directory, { recursive: true });
const decoded = PNG.sync.read(await readFile(path.join(root, 'sample-input/sample-1-GB.png')));
const input: RasterInput = { width: decoded.width, height: decoded.height, channels: 4, data: decoded.data };
const sourceCopy = Buffer.from(input.data), prepared = prepareTraceInput(input, 'black-gold');
const { binary, threshold } = binarize(prepared), colors = importPalette(DEFAULT_PALETTE, 'black-gold');
const contours = !process.argv.includes('--skeleton');
const started = performance.now();
const params = { inputMode: 'black-gold' as const, threshold: 'otsu' as const, invert: false, gapClosePx: 0, minSpeckArea: 16, simplifyTolerance: 1, fitMaxError: 1.5, spurPrunePx: 0 };
const gold = contours ? traceGoldArtwork(input, params) : undefined;
const trace = gold?.trace ?? traceImage(prepared, params);
const traceMs = performance.now() - started;
assert.deepEqual(input.data, sourceCopy); assert(trace.report.edges > 0); assert.equal(trace.params.inputMode, 'black-gold');
for (const edge of Object.values(trace.geometry.edges)) { assert.equal(edge.widthMode, 'design'); assert.equal(edge.strokeHidden, false); edge.colorIndex = colors.strokeColorIndex; }
console.log(JSON.stringify({ stage: 'trace', width: input.width, height: input.height, traceMs, edges: trace.report.edges, nodes: trace.report.nodes, threshold }));
const bounds = { w: input.width, h: input.height }, repeat = { type: 'none' as const };
const topologyStarted = performance.now(), topology = buildPlanarMap(trace.geometry, bounds, repeat), topologyMs = performance.now() - topologyStarted;
trace.report.faces = topology.faces.filter(face => face.outer).length;
trace.geometry.faceColors = gold ? goldFaceColors(topology.faces, gold.binary, input.width, input.height, colors.strokeColorIndex) : Object.fromEntries(topology.faces.map(face => [face.id, { colorIndex: face.outer === null ? 0 : null, ref: face.ref }]));
const rules = { minRegionPx: 0, minThicknessPx: 0, removeCheckerboard: false, connectVisibleEdges4: false };
const renderStarted = performance.now(), rendered = render(trace.geometry, topology.faces, bounds, colors.palette, input.width, input.height, rules, [], repeat), renderMs = performance.now() - renderStarted;
let intersection = 0, union = 0, missed = 0, extra = 0, foreground = 0;
for (let i = 0; i < binary.length; i++) { const expected = binary[i] !== 0, actual = rendered.grid[i] === colors.strokeColorIndex; if (expected) foreground++; if (expected && actual) intersection++; if (expected || actual) union++; if (expected && !actual) missed++; if (!expected && actual) extra++; }
const width = 720, height = Math.round(input.height * width / input.width), thumb = new Uint8Array(width * height), reference = new Uint8Array(width * height);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = Math.floor(y * input.height / height) * input.width + Math.floor(x * input.width / width); thumb[y * width + x] = rendered.grid[i]; reference[y * width + x] = binary[i] ? colors.strokeColorIndex : 0; }
await writeFile(path.join(directory, contours ? 'contour-preview.png' : 'trace-preview.png'), encodePng(thumb, width, height, colors.palette));
await writeFile(path.join(directory, 'extracted-ink-preview.png'), encodePng(reference, width, height, colors.palette));
await writeFile(path.join(directory, contours ? 'sample-contour.json' : 'sample-trace.json'), JSON.stringify({ bounds, repeat, trace }));
const report = { width: input.width, height: input.height, threshold, traceMs, topologyMs, renderMs, edges: trace.report.edges, nodes: trace.report.nodes, faces: trace.report.faces, foreground, intersectionOverUnion: intersection / union, missedFractionOfInk: missed / foreground, extraFractionOfInk: extra / foreground, warnings: [...trace.report.warnings, ...topology.warnings] };
await writeFile(path.join(directory, contours ? 'contour-report.json' : 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
if (contours) {
  const time = new Date().toISOString();
  const master = validateMaster({ schemaVersion: 1, id: 'sample-1-gold', workspaceId: 'local', name: 'Sample 1 — Black & Gold', tags: ['gold'], geometry: trace.geometry, objects: trace.objects, bounds, repeat, palette: colors.palette, source: { fileId: 'sample-1-GB.png', widthPx: input.width, heightPx: input.height }, traceParams: trace.params, version: 1, createdAt: time, updatedAt: time });
  await writeFile(path.join(directory, 'sample-1-GB.master.json'), JSON.stringify(master));
}
