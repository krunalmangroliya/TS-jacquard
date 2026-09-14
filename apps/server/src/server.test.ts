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
import { DEFAULT_PALETTE, DEFAULT_PROFILE, type Master } from '../../../packages/core/src/types';
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
beforeEach(async () => { clock = Date.parse('2026-09-12T12:00:00Z'); directory = await mkdtemp(path.join(tmpdir(), 'jdm-server-test-data-')); app = await createApp({ dataDir: directory, exportWorkerPath: workerPath, now: () => clock }); });
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

  it('validates binary thumbnails, geometry, operations, six-color palettes and profile references', async () => {
    const document = await create(), thumbnail = encodePng(new Uint8Array(64), 8, 8, DEFAULT_PALETTE);
    expect((await app.inject({ method: 'PUT', url: `/api/designs/${document.id}/thumbnail`, headers: { ...headers, 'content-type': 'image/png', 'x-jdm-client-id': 'client-a' }, payload: Buffer.from(thumbnail) })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/designs/${document.id}/thumbnail`, headers })).rawPayload).toEqual(Buffer.from(thumbnail));
    expect((await app.inject({ method: 'PUT', url: `/api/designs/${document.id}/thumbnail`, headers: { ...headers, 'content-type': 'image/png', 'x-jdm-client-id': 'client-a' }, payload: Buffer.from('not png') })).statusCode).toBe(400);
    expect((await put({ ...document, profileId: 'unknown-profile' })).statusCode).toBe(400);
    expect((await put({ ...document, operations: [{ t: 'unrecognized' }] as never })).statusCode).toBe(400);
    const bad = masterFixture(); bad.palette = { entries: [...bad.palette.entries, { ...bad.palette.entries[0], index: 6 }] };
    expect((await app.inject({ method: 'POST', url: '/api/designs', headers, payload: { master: bad } })).statusCode).toBe(400);
    bad.palette = DEFAULT_PALETTE; delete bad.geometry.nodes.a;
    expect((await app.inject({ method: 'POST', url: '/api/designs', headers, payload: { master: bad } })).statusCode).toBe(400);
  });

  it('rejects path traversal, foreign origins, rebound hosts and malformed IDs', async () => {
    expect((await app.inject({ url: '/api/designs/%2E%2E%2Fworkspace', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/workspace', headers: { host: 'attacker.example:4317' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/designs', headers: { ...headers, origin: 'https://attacker.example' }, payload: { master: masterFixture() } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/workspace', headers: { ...headers, origin: 'null' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/workspace', headers: { ...headers, origin: 'http://localhost:4317' } })).statusCode).toBe(200);
  });
});
