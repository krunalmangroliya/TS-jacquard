import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { DesignRecord, DesignSummary, ExportSummary, VersionSummary } from '../../../packages/app-model/src/index';
import { DEFAULT_RULES, DEFAULT_RASTER_RULES } from '../../../packages/core/src/types';
import { LocalStore, atomicWrite, type StoredDesign } from './store';
import { HttpError, clientSchema, decodePng, idSchema, mutationSchema, nameSchema, sizeSchema, validPng, validateRecord, validatedMaster, validateWorkspace } from './validation';
import { runExportWorker } from './export-runner';
import type { ExportArtifacts, ExportTask } from './export-worker';

export interface AppOptions {
  dataDir: string; staticDir?: string; exportWorkerPath?: string; logger?: boolean;
  now?: () => number; exportRunner?: (task: ExportTask) => Promise<ExportArtifacts>;
}
const copy = <T>(value: T): T => structuredClone(value);
const paramsSchema = z.object({ id: idSchema });
const getId = (request: FastifyRequest): string => paramsSchema.parse(request.params).id;

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 150 * 1024 * 1024, requestTimeout: 180_000 });
  const store = new LocalStore(options.dataDir); await store.initialize();
  const now = options.now ?? Date.now, iso = (): string => new Date(now()).toISOString();
  const locks = new Map<string, { clientId: string; expiresAt: number }>();
  const exportRunner = options.exportRunner ?? ((task: ExportTask) => runExportWorker(options.exportWorkerPath ?? fileURLToPath(new URL('./export-worker.mjs', import.meta.url)), task));
  let exportTail: Promise<unknown> = Promise.resolve(), pendingExports = 0;
  const queuedExport = async (task: ExportTask): Promise<ExportArtifacts> => {
    if (pendingExports >= 3) throw new HttpError(429, 'The local export queue is full. Wait for an export to finish.');
    pendingExports++;
    const run = exportTail.then(() => exportRunner(task), () => exportRunner(task)); exportTail = run.catch(() => {});
    try { return await run; } finally { pendingExports--; }
  };
  const currentLock = (id: string) => { const lock = locks.get(id); if (lock && lock.expiresAt <= now()) { locks.delete(id); return undefined; } return lock; };
  function writable(state: StoredDesign, clientId: string, expectedRevision?: number): void {
    const lock = currentLock(state.document.id);
    if (lock && lock.clientId !== clientId) throw new HttpError(423, 'This design is open for editing in another tab', 'DESIGN_LOCKED');
    if (expectedRevision !== undefined && state.document.revision !== expectedRevision) throw new HttpError(409, 'The design changed since it was loaded. Reload before saving.', 'REVISION_CONFLICT');
  }
  app.addHook('onRequest', async (request, reply) => {
    let host: URL;
    try { host = new URL(`http://${request.headers.host ?? ''}`); } catch { throw new HttpError(403, 'A localhost Host header is required'); }
    const isLocal = (hostname: string): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    if (!isLocal(host.hostname) || host.username || host.password) throw new HttpError(403, 'Only localhost requests are accepted');
    const origin = request.headers.origin;
    if (origin) {
      let parsed: URL; try { parsed = new URL(origin); } catch { throw new HttpError(403, 'This request origin is not allowed'); }
      if (!isLocal(parsed.hostname) || parsed.protocol !== 'http:' || parsed.port !== host.port) throw new HttpError(403, 'This request origin is not allowed');
    }
    if (request.headers['sec-fetch-site'] === 'cross-site' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) throw new HttpError(403, 'Cross-site changes are not allowed');
    reply.header('X-Content-Type-Options', 'nosniff').header('Cross-Origin-Resource-Policy', 'same-origin');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) { const first = error.issues[0]; reply.code(400).send({ error: first ? `${first.path.length ? first.path.join('.') + ': ' : ''}${first.message}` : 'Invalid request', details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })), code: 'VALIDATION_ERROR' }); return; }
    const status = error instanceof HttpError ? error.statusCode : typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    if (status >= 500) request.log.error(error);
    reply.code(status).send({ error: status >= 500 && !(error instanceof HttpError) ? 'Local storage could not complete the request' : error.message, code: error instanceof HttpError ? error.code : 'REQUEST_ERROR' });
  });
  app.addContentTypeParser(['image/png', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 16_000_000 }, (_request, body, done) => done(null, body));
  app.get('/api/health', async () => ({ ok: true, application: 'JDM', storage: 'local' }));
  app.get('/api/workspace', async () => store.workspace());
  app.put('/api/workspace', async request => store.serial(async () => {
    const settings = validateWorkspace(request.body), available = new Set(settings.profiles.map(p => p.id));
    for (const state of await store.list(true)) {
      if (!available.has(state.document.profileId)) throw new HttpError(409, 'A profile used by a saved design cannot be removed');
      for (const version of state.versions) if (!available.has((await store.snapshot(state.document.id, version.id, state)).document.profileId)) throw new HttpError(409, 'A profile used by a retained version cannot be removed');
    }
    return store.saveWorkspace(settings);
  }));

  async function designSummaries(request: FastifyRequest, archived: boolean): Promise<DesignSummary[]> {
    const query = z.object({ search: z.string().max(300).optional() }).parse(request.query), search = query.search?.trim().toLowerCase() ?? '';
    const states = await store.list(archived), counts = new Map<string, number>();
    for (const state of states) if (!state.archived && state.document.masterId) counts.set(state.document.masterId, (counts.get(state.document.masterId) ?? 0) + 1);
    return states.filter(state => state.archived === archived && (!search || [state.document.name, ...state.document.tags].some(text => text.toLowerCase().includes(search)))).map(({ document, hasThumbnail }): DesignSummary => ({ id: document.id, kind: document.kind, masterId: document.masterId, name: document.name, tags: document.tags, version: document.master.version, revision: document.revision, updatedAt: document.updatedAt, variantCount: counts.get(document.id) ?? 0, ...(hasThumbnail ? { thumbnailUrl: `/api/designs/${document.id}/thumbnail` } : {}) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  app.get('/api/designs', request => designSummaries(request, false));
  app.get('/api/archived', request => designSummaries(request, true));
  // Base64 source (110 MB), raster (40 MB) and thumbnail (16 MB), plus metadata.
  app.post('/api/designs', { bodyLimit: 224 * 1024 * 1024 }, async request => {
    const payload = z.object({ master: z.unknown(), name: nameSchema.optional(), sourcePngBase64: z.string().optional(), thumbnailPngBase64: z.string().optional() }).parse(request.body);
    const master = validatedMaster(payload.master), source = decodePng(payload.sourcePngBase64), thumbnail = decodePng(payload.thumbnailPngBase64, true);
    if (source && (source.readUInt32BE(16) !== master.source.widthPx || source.readUInt32BE(20) !== master.source.heightPx)) throw new HttpError(400, 'Source PNG dimensions do not match the master');
    return store.serial(async () => {
      const settings = await store.workspace(), id = randomUUID(), time = iso();
      const name = payload.name ?? master.name;
      const sizeInput = master.raster ? { mode: 'grid', widthPx: master.raster.width, heightPx: master.raster.height, linkAspect: false } : { mode: 'grid', widthPx: Math.min(600, settings.profiles.find(p => p.id === settings.defaultProfileId)!.hooks), linkAspect: true };
      const document = validateRecord({ id, kind: 'master', name, tags: master.tags, master: { ...master, id, workspaceId: 'local-jdm', name }, profileId: settings.defaultProfileId, sizeInput, rules: master.raster ? DEFAULT_RASTER_RULES : DEFAULT_RULES, pixelOverrides: [], operations: [], revision: 1, createdAt: time, updatedAt: time }, settings);
      const state: StoredDesign = { document, archived: false, versions: [], exports: [], hasSource: Boolean(source), hasThumbnail: Boolean(thumbnail) };
      if (source) await atomicWrite(store.file(id, 'source'), source); if (thumbnail) await atomicWrite(store.file(id, 'thumbnail'), thumbnail);
      const initial: VersionSummary = { id: randomUUID(), version: document.master.version, note: 'Imported master', createdAt: time };
      await store.saveSnapshot(id, { summary: initial, document }); state.versions.push(initial);
      await store.save(state); return document;
    });
  });
  app.get('/api/designs/:id', async request => (await store.get(getId(request))).document);
  app.put('/api/designs/:id', async request => store.serial(async () => {
    const id = getId(request), payload = mutationSchema.extend({ document: z.unknown() }).parse(request.body), current = await store.get(id);
    writable(current, payload.clientId, payload.expectedRevision);
    const next = validateRecord(payload.document, await store.workspace()), old = current.document;
    if (next.id !== id || next.kind !== old.kind || next.masterId !== old.masterId) throw new HttpError(400, 'Design identity and parent cannot be changed');
    const time = iso();
    current.document = { ...next, revision: old.revision + 1, createdAt: old.createdAt, updatedAt: time, master: { ...next.master, id: old.master.id, workspaceId: old.master.workspaceId, version: old.master.version, createdAt: old.master.createdAt, updatedAt: time, name: next.name, tags: next.tags } };
    await store.save(current); return current.document;
  }));
  app.post('/api/designs/:id/lock', async request => store.serial(async () => {
    const id = getId(request), { clientId } = z.object({ clientId: clientSchema }).parse(request.body); await store.get(id);
    const lock = currentLock(id);
    if (lock && lock.clientId !== clientId) return { acquired: false, expiresAt: new Date(lock.expiresAt).toISOString() };
    const expiresAt = now() + 5 * 60_000; locks.set(id, { clientId, expiresAt }); return { acquired: true, expiresAt: new Date(expiresAt).toISOString() };
  }));
  app.delete('/api/designs/:id/lock', async request => store.serial(async () => {
    const id = getId(request), { clientId } = z.object({ clientId: clientSchema }).parse(request.body); await store.get(id);
    if (currentLock(id)?.clientId === clientId) locks.delete(id); return { released: !currentLock(id) };
  }));

  async function saveVersion(state: StoredDesign, note: string): Promise<{ document: DesignRecord; version: VersionSummary }> {
    const time = iso(), versionNumber = Math.max(state.document.master.version, ...state.versions.map(v => v.version)) + 1;
    state.document = { ...state.document, revision: state.document.revision + 1, updatedAt: time, master: { ...state.document.master, version: versionNumber, updatedAt: time } };
    const version: VersionSummary = { id: randomUUID(), version: versionNumber, note, createdAt: time };
    await store.saveSnapshot(state.document.id, { summary: version, document: state.document });
    state.versions.push(version); await store.save(state); return { document: state.document, version };
  }
  app.post('/api/designs/:id/versions', async request => store.serial(async () => {
    const payload = mutationSchema.extend({ note: z.string().trim().max(500).default('') }).parse(request.body), state = await store.get(getId(request));
    writable(state, payload.clientId, payload.expectedRevision); return saveVersion(state, payload.note || 'Saved version');
  }));
  app.get('/api/designs/:id/versions', async request => [...(await store.get(getId(request))).versions].reverse());
  app.get('/api/designs/:id/versions/:versionId', async request => {
    const { id, versionId } = z.object({ id: idSchema, versionId: idSchema }).parse(request.params); return (await store.snapshot(id, versionId)).document;
  });
  app.post('/api/designs/:id/restore', async request => store.serial(async () => {
    const payload = mutationSchema.extend({ versionId: idSchema }).parse(request.body), state = await store.get(getId(request));
    writable(state, payload.clientId, payload.expectedRevision);
    const previous = await store.snapshot(state.document.id, payload.versionId, state), current = state.document;
    state.document = validateRecord({ ...previous.document, revision: current.revision, createdAt: current.createdAt, master: { ...previous.document.master, version: current.master.version } }, await store.workspace());
    return saveVersion(state, `Restored version ${previous.summary.version}`);
  }));
  app.post('/api/designs/:id/duplicate', async request => store.serial(async () => {
    const payload = z.object({ name: nameSchema.optional() }).parse(request.body ?? {}), source = await store.get(getId(request));
    const document = copy(source.document), id = randomUUID(), time = iso();
    document.id = id; document.name = payload.name ?? `${document.name.slice(0, 150)} copy`; document.createdAt = time; document.updatedAt = time; document.revision = 1;
    document.master = { ...document.master, id, name: document.name, createdAt: time, updatedAt: time };
    const state: StoredDesign = { document, archived: false, versions: [], exports: [] };
    await store.copyAssets(source.document.id, state);
    const initial: VersionSummary = { id: randomUUID(), version: document.master.version, note: 'Duplicated design', createdAt: time };
    await store.saveSnapshot(id, { summary: initial, document }); state.versions.push(initial); await store.save(state); return document;
  }));
  app.post('/api/designs/:id/variants', async request => store.serial(async () => {
    const payload = z.object({ name: nameSchema, profileId: idSchema, sizeInput: sizeSchema }).parse(request.body), source = await store.get(getId(request));
    if (source.document.kind !== 'master') throw new HttpError(400, 'Create a size from a master design');
    const id = randomUUID(), time = iso(), parent = source.document;
    const document = validateRecord({ ...copy(parent), id, kind: 'size', masterId: parent.id, baseMasterVersion: parent.master.version, name: payload.name, profileId: payload.profileId, sizeInput: payload.sizeInput, master: { ...copy(parent.master), id, name: payload.name }, operations: [], pixelOverrides: [], revision: 1, createdAt: time, updatedAt: time }, await store.workspace());
    const state: StoredDesign = { document, archived: false, versions: [], exports: [] };
    await store.copyAssets(parent.id, state);
    const initial: VersionSummary = { id: randomUUID(), version: document.master.version, note: 'Created size', createdAt: time };
    await store.saveSnapshot(id, { summary: initial, document }); state.versions.push(initial); await store.save(state); return document;
  }));
  app.delete('/api/designs/:id', async request => store.serial(async () => {
    const payload = mutationSchema.parse(request.body), state = await store.get(getId(request)); writable(state, payload.clientId, payload.expectedRevision);
    state.archived = true; state.document.revision++; state.document.updatedAt = iso(); await store.save(state); locks.delete(state.document.id); return { archived: true };
  }));
  app.post('/api/designs/:id/unarchive', async request => store.serial(async () => {
    const payload = mutationSchema.parse(request.body), state = await store.get(getId(request), true);
    // Archiving releases the edit lock. Recovery is protected by the persisted
    // revision and does not require taking a lock on an inaccessible document.
    if (state.document.revision !== payload.expectedRevision) throw new HttpError(409, 'The design changed since it was loaded. Reload before restoring it.', 'REVISION_CONFLICT');
    if (!state.archived) throw new HttpError(409, 'This design is already in the library', 'DESIGN_NOT_ARCHIVED');
    state.archived = false; state.document.revision++; state.document.updatedAt = iso();
    await store.save(state); return state.document;
  }));

  for (const kind of ['source', 'thumbnail'] as const) app.get(`/api/designs/:id/${kind}`, async (request, reply) => {
    const id = getId(request), state = await store.get(id, kind === 'thumbnail');
    if (!(kind === 'source' ? state.hasSource : state.hasThumbnail)) throw new HttpError(404, `${kind === 'source' ? 'Source image' : 'Thumbnail'} is not available`);
    return reply.type('image/png').send(await readFile(store.file(id, kind)));
  });
  app.put('/api/designs/:id/thumbnail', async request => {
    const id = getId(request), clientId = clientSchema.parse(request.headers['x-jdm-client-id']);
    if (!Buffer.isBuffer(request.body)) throw new HttpError(415, 'Send the thumbnail as image/png bytes');
    const bytes = request.body; validPng(bytes, true);
    return store.serial(async () => { const state = await store.get(id); writable(state, clientId); await atomicWrite(store.file(id, 'thumbnail'), bytes); state.hasThumbnail = true; await store.save(state); return { thumbnailUrl: `/api/designs/${id}/thumbnail` }; });
  });
  app.post('/api/designs/:id/exports', async request => {
    const id = getId(request), payload = mutationSchema.parse(request.body), createdAt = iso();
    const task = await store.serial(async () => { const state = await store.get(id); writable(state, payload.clientId, payload.expectedRevision); const settings = await store.workspace(), profile = settings.profiles.find(p => p.id === state.document.profileId); if (!profile) throw new HttpError(400, 'The machine profile is missing'); return { document: state.document, profile, createdAt }; });
    const artifacts = await queuedExport(task);
    return store.serial(async () => {
      const current = await store.get(id), exportId = randomUUID();
      const base = task.document.name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100) || 'design';
      const summary: ExportSummary = { id: exportId, filename: `${base}_${artifacts.widthPx}x${artifacts.heightPx}_r${task.document.revision}.bmp`, widthPx: artifacts.widthPx, heightPx: artifacts.heightPx, createdAt, revision: task.document.revision };
      await atomicWrite(store.exportFile(id, exportId, 'bmp'), artifacts.bmp); await atomicWrite(store.exportFile(id, exportId, 'png'), artifacts.png); await atomicWrite(store.exportFile(id, exportId, 'json'), artifacts.json);
      current.exports.push(summary); await store.save(current); return summary;
    });
  });
  app.get('/api/designs/:id/exports', async request => [...(await store.get(getId(request))).exports].reverse());
  app.get('/api/designs/:id/exports/:exportId/:format', async (request, reply) => {
    const { id, exportId, format } = z.object({ id: idSchema, exportId: idSchema, format: z.enum(['bmp', 'png', 'json']) }).parse(request.params);
    const summary = (await store.get(id)).exports.find(item => item.id === exportId); if (!summary) throw new HttpError(404, 'Export not found');
    const filename = summary.filename.replace(/\.bmp$/i, `.${format}`);
    return reply.header('Content-Disposition', `attachment; filename="${filename}"`).type(format === 'json' ? 'application/json' : `image/${format}`).send(await readFile(store.exportFile(id, exportId, format)));
  });

  if (options.staticDir) {
    const root = path.resolve(options.staticDir);
    if (await stat(root).then(entry => entry.isDirectory()).catch(() => false)) {
      await app.register(fastifyStatic, { root, prefix: '/', index: ['index.html'] });
      app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'API route not found' }) : request.method === 'GET' && !path.extname(request.url.split('?')[0]) ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Page not found' }));
    }
  }
  return app;
}
