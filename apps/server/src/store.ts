import { mkdir, open, readFile, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DesignRecord, ExportSummary, VersionSummary, WorkspaceSettings } from '../../../packages/app-model/src/index';
import { DEFAULT_PALETTE } from '../../../packages/core/src/types';
import { addMissingMachineProfiles, DEFAULT_MACHINE_PROFILE_ID, DEFAULT_MACHINE_PROFILES, MACHINE_PROFILE_CATALOG_VERSION } from '../../../packages/app-model/src/machine-presets';
import { HttpError, idSchema, validateWorkspace } from './validation';

export interface StoredDesign { document: DesignRecord; archived: boolean; versions: VersionSummary[]; exports: ExportSummary[]; hasSource?: boolean; hasThumbnail?: boolean }
export interface Snapshot { summary: VersionSummary; document: DesignRecord }

/** Write + fsync + rename; a failed write never replaces the last valid JSON. */
export async function atomicWrite(file: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temporary).catch(() => {}); throw error; }
  await handle.close();
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  // Windows does not permit opening directories for fsync. File contents are
  // flushed above; POSIX also flushes the directory entry after replacement.
  if (process.platform !== 'win32') { const parent = await open(path.dirname(file), 'r'); try { await parent.sync(); } finally { await parent.close(); } }
}
const json = (value: unknown): string => JSON.stringify(value) + '\n';
export class LocalStore {
  readonly root: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) { this.root = path.resolve(dataDir); }
  serial<T>(fn: () => Promise<T>): Promise<T> { const run = this.tail.then(fn, fn); this.tail = run.catch(() => {}); return run; }
  private designPath(id: string): string { return path.join(this.root, 'designs', idSchema.parse(id)); }
  file(id: string, kind: 'source' | 'thumbnail'): string { return path.join(this.designPath(id), `${kind}.png`); }
  exportFile(id: string, exportId: string, format: 'bmp' | 'png' | 'json'): string { return path.join(this.designPath(id), 'exports', `${idSchema.parse(exportId)}.${format}`); }
  async initialize(): Promise<void> {
    await mkdir(path.join(this.root, 'designs'), { recursive: true });
    let settings: WorkspaceSettings;
    try { settings = await this.workspace(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.saveWorkspace({ name: 'My Jacquard Studio', profiles: structuredClone(DEFAULT_MACHINE_PROFILES), defaultProfileId: DEFAULT_MACHINE_PROFILE_ID, defaultPalette: DEFAULT_PALETTE });
      return;
    }
    // Seed each catalog version once, so later edits and removals survive restarts.
    if ((settings.machineProfileCatalogVersion ?? 0) < MACHINE_PROFILE_CATALOG_VERSION) await this.saveWorkspace({ ...settings, profiles: addMissingMachineProfiles(settings.profiles) });
  }
  async workspace(): Promise<WorkspaceSettings> { return validateWorkspace(JSON.parse(await readFile(path.join(this.root, 'workspace.json'), 'utf8'))); }
  async saveWorkspace(value: WorkspaceSettings): Promise<WorkspaceSettings> {
    let catalogVersion = MACHINE_PROFILE_CATALOG_VERSION;
    try { catalogVersion = Math.max(catalogVersion, (await this.workspace()).machineProfileCatalogVersion ?? 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Migration metadata belongs to storage; older clients can omit it safely.
    const settings = validateWorkspace({ ...value, machineProfileCatalogVersion: catalogVersion });
    await atomicWrite(path.join(this.root, 'workspace.json'), json(settings));
    return settings;
  }
  async get(id: string, allowArchived = false): Promise<StoredDesign> {
    let value: StoredDesign;
    try { value = JSON.parse(await readFile(path.join(this.designPath(id), 'state.json'), 'utf8')) as StoredDesign; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'Design not found'); throw error; }
    if (value.archived && !allowArchived) throw new HttpError(404, 'Design is archived');
    return value;
  }
  async save(value: StoredDesign): Promise<void> { await atomicWrite(path.join(this.designPath(value.document.id), 'state.json'), json(value)); }
  async list(includeArchived = false): Promise<StoredDesign[]> {
    const directories = await readdir(path.join(this.root, 'designs'), { withFileTypes: true });
    const result: StoredDesign[] = [];
    for (const dir of directories) if (dir.isDirectory() && idSchema.safeParse(dir.name).success) {
      try { const value = await this.get(dir.name, true); if (includeArchived || !value.archived) result.push(value); }
      catch (error) { if (!(error instanceof HttpError && error.statusCode === 404)) throw error; }
    }
    return result;
  }
  async saveSnapshot(id: string, snapshot: Snapshot): Promise<void> { await atomicWrite(path.join(this.designPath(id), 'versions', `${idSchema.parse(snapshot.summary.id)}.json`), json(snapshot)); }
  async snapshot(id: string, versionId: string, state?: StoredDesign): Promise<Snapshot> {
    const current = state ?? await this.get(id);
    if (!current.versions.some(version => version.id === versionId)) throw new HttpError(404, 'Version not found');
    return JSON.parse(await readFile(path.join(this.designPath(id), 'versions', `${idSchema.parse(versionId)}.json`), 'utf8')) as Snapshot;
  }
  async copyAssets(fromId: string, to: StoredDesign): Promise<void> {
    const from = await this.get(fromId);
    for (const kind of ['source', 'thumbnail'] as const) if (kind === 'source' ? from.hasSource : from.hasThumbnail) await atomicWrite(this.file(to.document.id, kind), await readFile(this.file(fromId, kind)));
    to.hasSource = from.hasSource; to.hasThumbnail = from.hasThumbnail;
  }
}
