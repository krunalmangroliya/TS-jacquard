import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PNG } from 'pngjs';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app';
import { renderDocument } from './export-worker';
import { buildPlanarMap } from '../../../packages/core/src/topology';
import { encodePng } from '../../../packages/core/src/png';
import { encodeBmp } from '../../../packages/core/src/bmp';
import { DEFAULT_PALETTE, DEFAULT_PROFILE, DEFAULT_RASTER_RULES, MAX_COLORS, type Master, type Palette } from '../../../packages/core/src/types';
import { importColorImage, decodeRaster } from '../../../packages/core/src/raster';
import type { DesignRecord, VersionSummary } from '../../../packages/app-model/src/index';

const headers = { host: '127.0.0.1:4317' };
function masterFixture(): Master {
  const geometry: Master['geometry'] = { nodes: { a: { id: 'a', p: { x: 10, y: 10 }, kind: 'corner' }, b: { id: 'b', p: { x: 90, y: 10 }, kind: 'corner' }, c: { id: 'c', p: { x: 90, y: 90 }, kind: 'corner' }, d: { id: 'd', p: { x: 10, y: 90 }, kind: 'corner' } }, edges: { outline: { id: 'outline', nodeIds: ['a', 'b', 'c', 'd', 'a'], segments: [{}, {}, {}, {}], width: 1, colorIndex: 5, strokeHidden: false, z: 0 } }, faceColors: {} };
  const bounds = { w: 100, h: 100 };
  geometry.faceColors = Object.fromEntries(buildPlanarMap(geometry, bounds, { type: 'none' }).faces.map(face => [face.id, { colorIndex: face.outer ? 2 : 0, ref: face.ref }]));
  return { schemaVersion: 1, id: 'imported', workspaceId: 'fixture', name: 'Flower', tags: ['test'], geometry, bounds, repeat: { type: 'none' }, palette: DEFAULT_PALETTE, objects: [{ id: 'motif', name: 'Motif', edgeIds: ['outline'], locked: false, hidden: false }], source: { fileId: 'original.png', widthPx: 100, heightPx: 100 }, traceParams: { threshold: 'otsu', invert: false, minSpeckArea: 0, gapClosePx: 0, spurPrunePx: 0, simplifyTolerance: 1, fitMaxError: 1.5, cornerAngleDeg: 60 }, version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}
let app: FastifyInstance, directory: string, workerDir: string, workerPath: string, clock = Date.parse('2026-09-12T12:00:00Z');
async function removeTestDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory), root = path.resolve(tmpdir()) + path.sep;
  if (!resolved.startsWith(root) || !path.basename(resolved).startsWith('jdm-server-test-')) throw new Error('Refusing to remove a directory outside the generated test roots');
  await rm(resolved, { recursive: true, force: true });
}
beforeAll(async () => {
  workerDir = await mkdtemp(path.join(tmpdir(), 'jdm-server-test-worker-')); workerPath = path.join(workerDir, 'export-worker.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./export-worker.ts', import.meta.url))], outfile: workerPath, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
});
afterAll(async () => { await removeTestDirectory(workerDir); });
beforeEach(async () => {
  clock = Date.parse('2026-09-12T12:00:00Z'); directory = await mkdtemp(path.join(tmpdir(), 'jdm-server-test-data-')); app = await createApp({ dataDir: directory, exportWorkerPath: workerPath, now: () => clock });
  // These rendering fixtures explicitly use the historical 60 EPI / 48 PPI profile.
  const settings = (await app.inject({ url: '/api/workspace', headers })).json();
  settings.profiles.push(DEFAULT_PROFILE); settings.defaultProfileId = DEFAULT_PROFILE.id;
  const response = await app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: settings });
  expect(response.statusCode, response.body).toBe(200);
});
afterEach(async () => { await app.close(); await removeTestDirectory(directory); });
async function create(extra: Record<string, unknown> = {}): Promise<DesignRecord> {
  const response = await app.inject({ method: 'POST', url: '/api/designs', headers, payload: { master: masterFixture(), ...extra } });
  expect(response.statusCode, response.body).toBe(200); return response.json();
}
async function put(document: DesignRecord, clientId = 'client-a', expectedRevision = document.revision) {
  return app.inject({ method: 'PUT', url: `/api/designs/${document.id}`, headers, payload: { document, expectedRevision, clientId } });
}
const mutation = (document: DesignRecord, more: Record<string, unknown> = {}) => ({ expectedRevision: document.revision, clientId: 'client-a', ...more });

describe('local durable design API', () => {
  it('retains cleanup area, chosen colors and line settings through restart and scoped export', async () => {
    const pixels = new Uint8Array(64); pixels[18] = 2; pixels[22] = 2; pixels[50] = 3;
    const master: Master = { ...masterFixture(), geometry: { nodes: {}, edges: {}, faceColors: {} }, objects: [], bounds: { w: 8, h: 8 }, source: { fileId: 'scoped.png', widthPx: 8, heightPx: 8 }, raster: { width: 8, height: 8, pixelsBase64: Buffer.from(pixels).toString('base64') } };
    const parent = await create({ master }); expect(parent.rules).toEqual(DEFAULT_RASTER_RULES);
    const variant = await app.inject({ method: 'POST', url: `/api/designs/${parent.id}/variants`, headers, payload: { name: 'Scoped cleanup', profileId: DEFAULT_PROFILE.id, sizeInput: { mode: 'grid', widthPx: 8, heightPx: 8, linkAspect: false } } });
    let document = variant.json<DesignRecord>();
    document.rules = { ...DEFAULT_RASTER_RULES, minRegionPx: 4, cleanupRegion: { x: 0, y: 0, w: .5, h: 1 }, cleanupColorIndices: [2], outlineColorIndex: 1, rasterResize: 'preserve-outline', repairOutlineGaps: true };
    document.pixelOverrides = [{ x: 1, y: 1, colorIndex: 5 }];
    const saved = await put(document); expect(saved.statusCode, saved.body).toBe(200); document = saved.json();
    await app.close(); app = await createApp({ dataDir: directory, exportWorkerPath: workerPath, now: () => clock });
    const loaded = (await app.inject({ url: `/api/designs/${document.id}`, headers })).json<DesignRecord>(); expect(loaded.rules).toEqual(document.rules);
    const result = await app.inject({ method: 'POST', url: `/api/designs/${document.id}/exports`, headers, payload: mutation(document) });
    expect(result.statusCode, result.body).toBe(200); const exported = result.json();
    const png = PNG.sync.read((await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/png`, headers })).rawPayload);
    const expected = pixels.slice(); expected[18] = 0; expected[9] = 5;
    for (let index = 0; index < 64; index++) expect([...png.data.subarray(index * 4, index * 4 + 3)]).toEqual(master.palette.entries[expected[index]].exportRgb);
    const metadata = (await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/json`, headers })).json(); expect(metadata.rules).toEqual(document.rules); expect(metadata.changedPixelsByRule.minRegion).toBe(1);
    expect((await put({ ...document, rules: { ...document.rules, cleanupRegion: { x: .8, y: 0, w: .4, h: 1 } } })).statusCode).toBe(400);
    expect((await put({ ...document, rules: { ...document.rules, cleanupColorIndices: [6] } })).statusCode).toBe(400);
    expect((await put({ ...document, rules: { ...document.rules, outlineColorIndex: 6 } })).statusCode).toBe(400);
  });

  it.each([7, 256])('preserves %i uploaded colors through save, high-index painting, restart and export', async count => {
    const palette: Palette = { entries: Array.from({ length: count }, (_, index) => ({ index, name: `Color ${index}`, displayRgb: [index, (index * 71) % 256, (index * 113) % 256], exportRgb: [index, (index * 71) % 256, (index * 113) % 256] })) };
    const pixels = Uint8Array.from({ length: 256 }, (_, index) => index % count);
    const decoded = Uint8Array.from([...pixels].flatMap(index => palette.entries[index].exportRgb));
    const imported = importColorImage({ width: 16, height: 16, channels: 3, data: decoded });
    expect(imported.quantized).toBe(false); expect(imported.palette.entries).toHaveLength(count);
    const master: Master = { ...masterFixture(), palette: imported.palette, raster: imported.raster, geometry: { nodes: {}, edges: {}, faceColors: {} }, objects: [], bounds: { w: 16, h: 16 }, source: { fileId: 'colors.png', widthPx: 16, heightPx: 16 } };
    const source = encodePng(pixels, 16, 16, palette), parent = await create({ master, sourcePngBase64: Buffer.from(source).toString('base64') });
    const response = await app.inject({ method: 'POST', url: `/api/designs/${parent.id}/variants`, headers, payload: { name: `${count} colors`, profileId: DEFAULT_PROFILE.id, sizeInput: { mode: 'grid', widthPx: 16, heightPx: 16, linkAspect: false } } });
    expect(response.statusCode, response.body).toBe(200); let document = response.json<DesignRecord>();
    document.rules = { minRegionPx: 0, minThicknessPx: 0, removeCheckerboard: false, connectVisibleEdges4: false, protectedColorIndices: [count - 1] };
    document.pixelOverrides = [{ x: 0, y: 0, colorIndex: count - 1 }];
    const saved = await put(document); expect(saved.statusCode, saved.body).toBe(200); document = saved.json();
    await app.close(); app = await createApp({ dataDir: directory, exportWorkerPath: workerPath, now: () => clock });
    const loaded = (await app.inject({ url: `/api/designs/${document.id}`, headers })).json<DesignRecord>();
    expect(loaded.master.palette).toEqual(imported.palette); expect(loaded.pixelOverrides).toEqual(document.pixelOverrides);
    const result = await app.inject({ method: 'POST', url: `/api/designs/${document.id}/exports`, headers, payload: mutation(document) });
    expect(result.statusCode, result.body).toBe(200); const exported = result.json();
    const expected = decodeRaster(imported.raster); expected[0] = count - 1;
    const bmp = (await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/bmp`, headers })).rawPayload;
    expect(bmp).toEqual(Buffer.from(encodeBmp(expected, 16, 16, imported.palette, DEFAULT_PROFILE)));
    expect(bmp.readUInt16LE(28)).toBe(8); expect(bmp.readUInt32LE(46)).toBe(256);
    const png = PNG.sync.read((await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/png`, headers })).rawPayload);
    for (let index = 0; index < expected.length; index++) expect([...png.data.subarray(index * 4, index * 4 + 3)]).toEqual(imported.palette.entries[expected[index]].exportRgb);
    const invalid = await put({ ...document, pixelOverrides: [{ x: 0, y: 0, colorIndex: count }] });
    expect(invalid.statusCode).toBe(400);
  });

  it('persists a colored upload and its resized pixel corrections through restart and indexed export', async () => {
    const pixels = Uint8Array.from({ length: 64 }, (_, i) => i < 32 ? i % 8 < 4 ? 1 : 2 : i % 8 < 4 ? 3 : 4);
    const master: Master = { ...masterFixture(), geometry: { nodes: {}, edges: {}, faceColors: {} }, objects: [], bounds: { w: 8, h: 8 }, source: { fileId: 'upload.png', widthPx: 8, heightPx: 8 }, raster: { width: 8, height: 8, pixelsBase64: Buffer.from(pixels).toString('base64') } };
    const source = encodePng(pixels, 8, 8, master.palette), parent = await create({ master, sourcePngBase64: Buffer.from(source).toString('base64') });
    expect(parent.master.raster).toEqual(master.raster); expect(parent.sizeInput).toEqual({ mode: 'grid', widthPx: 8, heightPx: 8, linkAspect: false });
    const sizeInput = { mode: 'grid', widthPx: 16, heightPx: 16, linkAspect: false };
    const response = await app.inject({ method: 'POST', url: `/api/designs/${parent.id}/variants`, headers, payload: { name: 'Resized image', profileId: DEFAULT_PROFILE.id, sizeInput } });
    expect(response.statusCode, response.body).toBe(200); let document = response.json<DesignRecord>();
    document.rules = { minRegionPx: 0, minThicknessPx: 0, removeCheckerboard: false, connectVisibleEdges4: false }; document.pixelOverrides = [{ x: 0, y: 0, colorIndex: 5 }];
    document = (await put(document)).json<DesignRecord>();
    await app.close(); app = await createApp({ dataDir: directory, exportWorkerPath: workerPath, now: () => clock });
    const loaded = (await app.inject({ url: `/api/designs/${document.id}`, headers })).json<DesignRecord>();
    expect(loaded.master.raster).toEqual(master.raster); expect(loaded.sizeInput).toEqual(sizeInput); expect(loaded.pixelOverrides).toEqual(document.pixelOverrides);
    expect((await app.inject({ url: `/api/designs/${parent.id}/source`, headers })).rawPayload).toEqual(Buffer.from(source));
    const result = await app.inject({ method: 'POST', url: `/api/designs/${document.id}/exports`, headers, payload: mutation(document) });
    expect(result.statusCode, result.body).toBe(200); const exported = result.json();
    const expected = Uint8Array.from({ length: 256 }, (_, i) => pixels[Math.floor(Math.floor(i / 16) / 2) * 8 + Math.floor(i % 16 / 2)]); expected[0] = 5;
    const bmp = (await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/bmp`, headers })).rawPayload;
    expect(bmp).toEqual(Buffer.from(encodeBmp(expected, 16, 16, master.palette, DEFAULT_PROFILE)));
    const png = (await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/png`, headers })).rawPayload;
    expect(png).toEqual(Buffer.from(encodePng(expected, 16, 16, master.palette)));
    const metadata = (await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/json`, headers })).json();
    expect(metadata.unassignedFaces).toBe(0); expect(metadata.pixelOverrides).toEqual(document.pixelOverrides);
  });

  it('persists drafts, source images and settings after restarting the app', async () => {
    const source = encodePng(new Uint8Array(10_000), 100, 100, DEFAULT_PALETTE), original = await create({ sourcePngBase64: Buffer.from(source).toString('base64') });
    original.name = 'Persisted flower'; const saved = (await put(original)).json<DesignRecord>();
    const settings = (await app.inject({ url: '/api/workspace', headers })).json(); settings.name = 'My local studio';
    expect((await app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: settings })).statusCode).toBe(200);
    await app.close(); app = await createApp({ dataDir: directory, exportWorkerPath: workerPath, now: () => clock });
    expect((await app.inject({ url: `/api/designs/${saved.id}`, headers })).json()).toEqual(saved);
    expect((await app.inject({ url: '/api/workspace', headers })).json().name).toBe('My local studio');
    expect((await app.inject({ url: `/api/designs/${saved.id}/source`, headers })).rawPayload).toEqual(Buffer.from(source));
    expect((await app.inject({ url: `/api/designs/${saved.id}/versions`, headers })).json()).toHaveLength(1);
  });

  it('serializes competing CAS saves and rejects stale writes without losing the winner', async () => {
    const original = await create();
    const results = await Promise.all([put({ ...original, name: 'First' }), put({ ...original, name: 'Second' })]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const winner = results.find(r => r.statusCode === 200)!.json<DesignRecord>();
    expect(winner.revision).toBe(2); expect((await app.inject({ url: `/api/designs/${original.id}`, headers })).json()).toEqual(winner);
    expect(results.find(r => r.statusCode === 409)!.json().code).toBe('REVISION_CONFLICT');
  });

  it('renews five-minute soft locks and blocks another active client', async () => {
    const document = await create(), url = `/api/designs/${document.id}/lock`;
    expect((await app.inject({ method: 'POST', url, headers, payload: { clientId: 'client-a' } })).json().acquired).toBe(true);
    expect((await app.inject({ method: 'POST', url, headers, payload: { clientId: 'client-b' } })).json().acquired).toBe(false);
    expect((await put(document, 'client-b')).statusCode).toBe(423);
    expect((await app.inject({ method: 'DELETE', url, headers, payload: { clientId: 'client-b' } })).json().released).toBe(false);
    clock += 300_001;
    expect((await app.inject({ method: 'POST', url, headers, payload: { clientId: 'client-b' } })).json().acquired).toBe(true);
    expect((await put({ ...document, name: 'After expiry' }, 'client-b')).statusCode).toBe(200);
  });

  it('retains immutable versions and restores an older one as a new version', async () => {
    let document = await create();
    const initial = (await app.inject({ url: `/api/designs/${document.id}/versions`, headers })).json<VersionSummary[]>()[0];
    document = (await put({ ...document, name: 'Version two' })).json();
    const version = (await app.inject({ method: 'POST', url: `/api/designs/${document.id}/versions`, headers, payload: mutation(document, { note: 'Approved colors' }) })).json<{ document: DesignRecord; version: VersionSummary }>();
    expect(version.document.master.version).toBe(2);
    document = (await put({ ...version.document, name: 'Unsaved draft edits' })).json();
    const restored = (await app.inject({ method: 'POST', url: `/api/designs/${document.id}/restore`, headers, payload: mutation(document, { versionId: initial.id }) })).json<{ document: DesignRecord; version: VersionSummary }>();
    expect(restored.document.name).toBe('Flower'); expect(restored.document.revision).toBe(document.revision + 1); expect(restored.version.version).toBe(3);
    const old = (await app.inject({ url: `/api/designs/${document.id}/versions/${version.version.id}`, headers })).json<DesignRecord>();
    expect(old.name).toBe('Version two'); expect(old.master.version).toBe(2);
    expect((await app.inject({ url: `/api/designs/${document.id}/versions`, headers })).json()).toHaveLength(3);
  });

  it('freezes independent size variants and copies, then archives without deleting their files', async () => {
    let parent = await create();
    const response = await app.inject({ method: 'POST', url: `/api/designs/${parent.id}/variants`, headers, payload: { name: 'Small flower', profileId: DEFAULT_PROFILE.id, sizeInput: { mode: 'grid', widthPx: 60, heightPx: 48, linkAspect: true } } });
    expect(response.statusCode, response.body).toBe(200); const variant = response.json<DesignRecord>();
    expect(variant.kind).toBe('size'); expect(variant.masterId).toBe(parent.id); expect(variant.operations).toEqual([]);
    parent.master.geometry.nodes.a.p.x = 15; parent = (await put(parent)).json();
    expect((await app.inject({ url: `/api/designs/${variant.id}`, headers })).json<DesignRecord>().master.geometry.nodes.a.p.x).toBe(10);
    const duplicate = (await app.inject({ method: 'POST', url: `/api/designs/${variant.id}/duplicate`, headers, payload: {} })).json<DesignRecord>();
    expect(duplicate.id).not.toBe(variant.id); expect(duplicate.kind).toBe('size'); expect(duplicate.masterId).toBe(parent.id);
    expect((await app.inject({ method: 'DELETE', url: `/api/designs/${parent.id}`, headers, payload: mutation(parent) })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/designs/${parent.id}`, headers })).statusCode).toBe(404);
    expect((await stat(path.join(directory, 'designs', parent.id, 'state.json'))).isFile()).toBe(true);
    expect((await app.inject({ url: `/api/designs/${variant.id}`, headers })).statusCode).toBe(200);
  });

  it('runs the actual export worker and serves exact indexed BMP/PNG bytes and metadata', async () => {
    let document = await create(); document.sizeInput = { mode: 'grid', widthPx: 50, heightPx: 40, linkAspect: true }; document.rules = { minRegionPx: 0, minThicknessPx: 0, removeCheckerboard: false, connectVisibleEdges4: false }; document.pixelOverrides = [{ x: 0, y: 0, colorIndex: 3 }];
    document = (await put(document)).json();
    const response = await app.inject({ method: 'POST', url: `/api/designs/${document.id}/exports`, headers, payload: mutation(document) });
    expect(response.statusCode, response.body).toBe(200); const exported = response.json();
    const expected = renderDocument({ document, profile: DEFAULT_PROFILE, createdAt: exported.createdAt });
    const bmp = await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/bmp`, headers });
    expect(bmp.rawPayload).toEqual(Buffer.from(expected.bmp)); expect(bmp.headers['content-disposition']).toContain('.bmp');
    const png = (await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/png`, headers })).rawPayload;
    expect(png).toEqual(Buffer.from(expected.png)); expect(PNG.sync.read(png).width).toBe(50);
    const sidecar = (await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/json`, headers })).json();
    expect(sidecar.document.revision).toBe(document.revision); expect(sidecar.pixelOverrides).toEqual(document.pixelOverrides);
    expect((await app.inject({ url: `/api/designs/${document.id}/exports`, headers })).json()).toHaveLength(1);
  });

  it('lists archived designs after restart and recovers their files and versions with revision protection', async () => {
    const thumbnail = encodePng(new Uint8Array(64), 8, 8, DEFAULT_PALETTE);
    const document = await create({ thumbnailPngBase64: Buffer.from(thumbnail).toString('base64') }), active = await create({ name: 'Still active' });
    const saved = (await app.inject({ method: 'POST', url: `/api/designs/${document.id}/versions`, headers, payload: mutation(document, { note: 'Before archive' }) })).json<{ document: DesignRecord; version: VersionSummary }>();
    await app.inject({ method: 'POST', url: `/api/designs/${document.id}/lock`, headers, payload: { clientId: 'client-a' } });
    expect((await app.inject({ method: 'DELETE', url: `/api/designs/${document.id}`, headers, payload: mutation(saved.document) })).statusCode).toBe(200);
    await app.close(); app = await createApp({ dataDir: directory, exportWorkerPath: workerPath, now: () => clock });
    const archived = (await app.inject({ url: '/api/archived', headers })).json();
    expect(archived.map((item: { id: string }) => item.id)).toEqual([document.id]);
    expect(archived[0].revision).toBe(saved.document.revision + 1);
    expect((await app.inject({ url: '/api/designs', headers })).json().map((item: { id: string }) => item.id)).toEqual([active.id]);
    expect((await app.inject({ url: '/api/archived?search=missing', headers })).json()).toEqual([]);
    expect((await app.inject({ url: archived[0].thumbnailUrl, headers })).rawPayload).toEqual(Buffer.from(thumbnail));
    expect((await app.inject({ method: 'POST', url: `/api/designs/${document.id}/lock`, headers, payload: { clientId: 'client-b' } })).statusCode).toBe(404);
    const url = `/api/designs/${document.id}/unarchive`;
    expect((await app.inject({ method: 'POST', url, headers, payload: mutation(saved.document, { clientId: 'client-b' }) })).json().code).toBe('REVISION_CONFLICT');
    expect((await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: archived[0].revision, clientId: '../invalid' } })).statusCode).toBe(400);
    const results = await Promise.all(['client-b', 'client-c'].map(clientId => app.inject({ method: 'POST', url, headers, payload: { expectedRevision: archived[0].revision, clientId } })));
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const restored = results.find(result => result.statusCode === 200)!.json<DesignRecord>();
    expect(restored.revision).toBe(archived[0].revision + 1); expect(restored.master).toEqual(saved.document.master);
    expect((await app.inject({ url: '/api/archived', headers })).json()).toEqual([]);
    expect((await app.inject({ url: `/api/designs/${document.id}`, headers })).json()).toEqual(restored);
    expect((await app.inject({ url: `/api/designs/${document.id}/versions`, headers })).json()).toHaveLength(2);
    expect((await app.inject({ url: `/api/designs/${document.id}/versions/${saved.version.id}`, headers })).json()).toEqual(saved.document);
    expect((await app.inject({ method: 'POST', url, headers, payload: mutation(restored) })).json().code).toBe('DESIGN_NOT_ARCHIVED');
    expect((await put({ ...restored, name: 'Recovered and editable' }, 'client-b')).statusCode).toBe(200);
  });

  it('keeps API reads and autosaves available during an export without overwriting newer edits', async () => {
    await app.close(); let start!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; }), released = new Promise<void>(resolve => { finish = resolve; });
    app = await createApp({ dataDir: directory, exportRunner: async task => { start(); await released; return renderDocument(task); } });
    const document = await create();
    const exporting = app.inject({ method: 'POST', url: `/api/designs/${document.id}/exports`, headers, payload: mutation(document) });
    await started;
    expect((await app.inject({ url: '/api/health', headers })).statusCode).toBe(200);
    const saved = (await put({ ...document, name: 'Edited while exporting' })).json<DesignRecord>();
    finish(); expect((await exporting).json().revision).toBe(document.revision);
    expect((await app.inject({ url: `/api/designs/${document.id}`, headers })).json()).toEqual(saved);
  });

  it('validates binary thumbnails, geometry, operations, indexed palettes and profile references', async () => {
    const document = await create(), thumbnail = encodePng(new Uint8Array(64), 8, 8, DEFAULT_PALETTE);
    expect((await app.inject({ method: 'PUT', url: `/api/designs/${document.id}/thumbnail`, headers: { ...headers, 'content-type': 'image/png', 'x-jdm-client-id': 'client-a' }, payload: Buffer.from(thumbnail) })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/designs/${document.id}/thumbnail`, headers })).rawPayload).toEqual(Buffer.from(thumbnail));
    expect((await app.inject({ method: 'PUT', url: `/api/designs/${document.id}/thumbnail`, headers: { ...headers, 'content-type': 'image/png', 'x-jdm-client-id': 'client-a' }, payload: Buffer.from('not png') })).statusCode).toBe(400);
    expect((await put({ ...document, profileId: 'unknown-profile' })).statusCode).toBe(400);
    expect((await put({ ...document, operations: [{ t: 'unrecognized' }] as never })).statusCode).toBe(400);
    const bad = masterFixture(); bad.palette = { entries: Array.from({ length: MAX_COLORS + 1 }, (_, index) => ({ ...DEFAULT_PALETTE.entries[0], index })) };
    expect((await app.inject({ method: 'POST', url: '/api/designs', headers, payload: { master: bad } })).statusCode).toBe(400);
    bad.palette = DEFAULT_PALETTE; delete bad.geometry.nodes.a;
    expect((await app.inject({ method: 'POST', url: '/api/designs', headers, payload: { master: bad } })).statusCode).toBe(400);
    const oversizedRaster = { ...masterFixture(), raster: { width: 8193, height: 1, pixelsBase64: Buffer.alloc(8193).toString('base64') } };
    const rejected = await app.inject({ method: 'POST', url: '/api/designs', headers, payload: { master: oversizedRaster } });
    expect(rejected.statusCode).toBe(400); expect(rejected.json().error).toContain('Raster dimensions');
  });

  it('rejects path traversal, foreign origins, rebound hosts and malformed IDs', async () => {
    expect((await app.inject({ url: '/api/designs/%2E%2E%2Fworkspace', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/workspace', headers: { host: 'attacker.example:4317' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/designs', headers: { ...headers, origin: 'https://attacker.example' }, payload: { master: masterFixture() } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/workspace', headers: { ...headers, origin: 'null' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/workspace', headers: { ...headers, origin: 'http://localhost:4317' } })).statusCode).toBe(200);
  });
});

describe('prepared source proportions and reviewed cleanup exports', () => {
  it('retains multiple repair colors through restart and exports both source-supported repairs without a single outline selection', async () => {
    const palette: Palette = { entries: Array.from({ length: 256 }, (_, index) => ({ index, name: `Color ${index}`, displayRgb: [index, 255 - index, 50], exportRgb: [index, 255 - index, 50] })) };
    const sourcePixels = new Uint8Array(9 * 18);
    for (const [offset, color] of [[0, 1], [9, 255]]) {
      for (let x = 0; x < 9; x++) sourcePixels[(offset + (x >= 3 && x <= 5 ? 3 : 4)) * 9 + x] = color;
      sourcePixels[(offset + 3) * 9 + 2] = color; sourcePixels[(offset + 3) * 9 + 6] = color;
    }
    const master: Master = {
      ...masterFixture(), palette, geometry: { nodes: {}, edges: {}, faceColors: {} }, objects: [],
      bounds: { w: 9, h: 18 }, source: { fileId: 'two-lines.png', widthPx: 9, heightPx: 18 },
      raster: { width: 9, height: 18, pixelsBase64: Buffer.from(sourcePixels).toString('base64') },
    };
    const parent = await create({ master });
    const variant = await app.inject({ method: 'POST', url: `/api/designs/${parent.id}/variants`, headers, payload: {
      name: 'Two repair colors', profileId: DEFAULT_PROFILE.id, sizeInput: { mode: 'grid', widthPx: 3, heightPx: 6, linkAspect: false },
    } });
    expect(variant.statusCode, variant.body).toBe(200);
    let document = variant.json<DesignRecord>();
    document.rules = { ...DEFAULT_RASTER_RULES, outlineAlgorithm: 'conservative', repairOutlineGaps: true, repairColorIndices: [255, 1], cleanupColorIndices: [0], protectedColorIndices: [2] };
    document.pixelOverrides = [{ x: 0, y: 0, colorIndex: 2 }];
    const saved = await put(document); expect(saved.statusCode, saved.body).toBe(200); document = saved.json();
    await app.close(); app = await createApp({ dataDir: directory, exportWorkerPath: workerPath, now: () => clock });
    const loaded = (await app.inject({ url: `/api/designs/${document.id}`, headers })).json<DesignRecord>();
    expect(loaded.rules).toEqual(document.rules); expect(loaded.rules.outlineColorIndex).toBeUndefined();
    const result = await app.inject({ method: 'POST', url: `/api/designs/${document.id}/exports`, headers, payload: mutation(document) });
    expect(result.statusCode, result.body).toBe(200); const exported = result.json();
    const expected = Uint8Array.from([2, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 0]);
    const bmp = (await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/bmp`, headers })).rawPayload;
    expect(bmp).toEqual(Buffer.from(encodeBmp(expected, 3, 6, palette, DEFAULT_PROFILE)));
    const direct = renderDocument({ document: loaded, profile: DEFAULT_PROFILE, createdAt: exported.createdAt });
    expect(bmp).toEqual(Buffer.from(direct.bmp));
    const metadata = (await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/json`, headers })).json();
    expect(metadata.rules.repairColorIndices).toEqual([255, 1]); expect(metadata.rules.outlineColorIndex).toBeUndefined();
    expect(metadata.changedPixelsByRule.repairOutlineGaps).toBe(2);
    const counts = new Array(256).fill(0); counts[0] = 11; counts[1] = 3; counts[2] = 1; counts[255] = 3;
    expect(metadata.colorPixelCounts).toEqual(counts); expect(metadata.colorsUsed).toEqual([0, 1, 2, 255]);
    expect(metadata.colorPixelCounts).toEqual(JSON.parse(direct.json).colorPixelCounts);
  });

  it('rejects invalid stored repair-color selections even when repair is disabled', async () => {
    const document = await create();
    const valid = { ...DEFAULT_RASTER_RULES, outlineAlgorithm: 'conservative' as const, repairOutlineGaps: false, repairColorIndices: [1, 2] };
    for (const rules of [
      { ...valid, repairColorIndices: [] },
      { ...valid, repairColorIndices: [1, 1] },
      { ...valid, repairColorIndices: [6] },
      { ...valid, repairColorIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
      { ...valid, outlineAlgorithm: 'legacy' },
      { ...valid, outlineAlgorithm: undefined },
      { ...valid, repairOutlineGaps: true, rasterResize: 'preserve-outline' },
    ]) {
      const rejected = await put({ ...document, rules } as DesignRecord);
      expect(rejected.statusCode, rejected.body).toBe(400);
    }
    expect((await app.inject({ url: `/api/designs/${document.id}`, headers })).json<DesignRecord>().revision).toBe(document.revision);
  });

  it.each([
    { name: 'known source density', density: { epi: 200, ppi: 76 }, pixelAspect: 200 / 76 },
    { name: 'unknown source density', density: undefined, pixelAspect: null },
  ])('persists $name and exports the explicit grid with exact conservative cleanup counts', async ({ density, pixelAspect }) => {
    const sourcePixels = new Uint8Array(81);
    // A continuous source line misses the center sample after reducing 9 × 9 to 3 × 3.
    for (let x = 0; x < 9; x++) sourcePixels[(x >= 3 && x <= 5 ? 3 : 4) * 9 + x] = 1;
    sourcePixels[3 * 9 + 2] = 1; sourcePixels[3 * 9 + 6] = 1;
    const interpretation = { version: 1 as const, kind: 'loom-grid' as const, ...(density ? { density } : {}) };
    const master: Master = {
      ...masterFixture(), geometry: { nodes: {}, edges: {}, faceColors: {} }, objects: [],
      bounds: { w: 9, h: 9, pixelAspect },
      source: { fileId: 'prepared.png', widthPx: 9, heightPx: 9, interpretation },
      raster: { width: 9, height: 9, pixelsBase64: Buffer.from(sourcePixels).toString('base64') },
    };
    const parent = await create({ master });
    expect(parent.master.source.interpretation).toEqual(interpretation);
    expect(parent.master.bounds.pixelAspect).toBe(pixelAspect);
    const variantsUrl = `/api/designs/${parent.id}/variants`;
    if (!density) {
      for (const sizeInput of [{ mode: 'grid', widthPx: 3, linkAspect: true }, { mode: 'fitAcross', n: 2 }]) {
        const rejected = await app.inject({ method: 'POST', url: variantsUrl, headers, payload: { name: 'Unconfirmed proportions', profileId: DEFAULT_PROFILE.id, sizeInput } });
        expect(rejected.statusCode, rejected.body).toBe(400);
        expect(rejected.json().error).toContain('source EPI and PPI');
      }
    }
    const sizeInput = { mode: 'grid', widthPx: 3, heightPx: 3, linkAspect: false };
    const variant = await app.inject({ method: 'POST', url: variantsUrl, headers, payload: { name: 'Reviewed prepared grid', profileId: DEFAULT_PROFILE.id, sizeInput } });
    expect(variant.statusCode, variant.body).toBe(200);
    let document = variant.json<DesignRecord>();
    document.rules = { ...DEFAULT_RASTER_RULES, outlineAlgorithm: 'conservative', outlineColorIndex: 1, repairOutlineGaps: true, cleanupColorIndices: [0], protectedColorIndices: [2] };
    document.pixelOverrides = [{ x: 0, y: 0, colorIndex: 3 }];
    const saved = await put(document); expect(saved.statusCode, saved.body).toBe(200); document = saved.json();
    await app.close(); app = await createApp({ dataDir: directory, exportWorkerPath: workerPath, now: () => clock });
    const loadedParent = (await app.inject({ url: `/api/designs/${parent.id}`, headers })).json<DesignRecord>();
    const loaded = (await app.inject({ url: `/api/designs/${document.id}`, headers })).json<DesignRecord>();
    for (const record of [loadedParent, loaded]) {
      expect(record.master.bounds).toEqual(master.bounds);
      expect(record.master.source.interpretation).toEqual(interpretation);
    }
    expect(loaded.rules).toEqual(document.rules); expect(loaded.sizeInput).toEqual(sizeInput);
    const result = await app.inject({ method: 'POST', url: `/api/designs/${document.id}/exports`, headers, payload: mutation(document) });
    expect(result.statusCode, result.body).toBe(200); const exported = result.json();
    expect([exported.widthPx, exported.heightPx]).toEqual([3, 3]);
    const expected = Uint8Array.from([3, 0, 0, 1, 1, 1, 0, 0, 0]);
    const bmp = (await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/bmp`, headers })).rawPayload;
    expect(bmp).toEqual(Buffer.from(encodeBmp(expected, 3, 3, master.palette, DEFAULT_PROFILE)));
    const metadata = (await app.inject({ url: `/api/designs/${document.id}/exports/${exported.id}/json`, headers })).json();
    expect(metadata.sourceInterpretation).toEqual(interpretation); expect(metadata.sourcePixelAspect).toBe(pixelAspect);
    expect(metadata.rules).toEqual(document.rules); expect(metadata.pixelOverrides).toEqual(document.pixelOverrides);
    expect(metadata.changedPixelsByRule.repairOutlineGaps).toBe(1);
    expect(metadata.colorPixelCounts).toEqual([5, 3, 0, 1, 0, 0]);
    expect(metadata.colorPixelCounts.reduce((sum: number, count: number) => sum + count, 0)).toBe(9);
    expect(metadata.colorsUsed).toEqual([0, 1, 3]);
    if (!density) expect(metadata.warnings.some((warning: string) => warning.includes('Source density is unknown'))).toBe(true);
  });
});
