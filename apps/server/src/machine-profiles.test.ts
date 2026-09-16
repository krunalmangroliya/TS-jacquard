import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { WorkspaceSettings } from '../../../packages/app-model/src/index';
import { DEFAULT_MACHINE_PROFILE_ID, DEFAULT_MACHINE_PROFILES, MACHINE_PROFILE_CATALOG_VERSION, MAX_MACHINE_PROFILES } from '../../../packages/app-model/src/machine-presets';
import { DEFAULT_PALETTE, DEFAULT_PROFILE, type MachineProfile } from '../../../packages/core/src/types';
import { createApp } from './app';
import { LocalStore } from './store';

const headers = { host: '127.0.0.1:4317' };
let directory: string, app: FastifyInstance | undefined;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'jdm-profiles-test-')); });
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
  const resolved = path.resolve(directory), root = path.resolve(tmpdir()) + path.sep;
  if (!resolved.startsWith(root) || !path.basename(resolved).startsWith('jdm-profiles-test-')) throw new Error('Refusing to remove a directory outside the generated profile test root');
  await rm(resolved, { recursive: true, force: true });
});
function oldSettings(profiles: MachineProfile[] = [DEFAULT_PROFILE]): WorkspaceSettings {
  const defaultPalette = structuredClone(DEFAULT_PALETTE); defaultPalette.entries[0].name = 'My ground';
  return { name: 'My existing studio', profiles, defaultProfileId: profiles[0].id, defaultPalette };
}
async function writeOldWorkspace(settings: WorkspaceSettings): Promise<void> { await writeFile(path.join(directory, 'workspace.json'), JSON.stringify(settings)); }

describe('machine profile catalog storage', () => {
  it('seeds a fresh workspace with all presets and the 96 EPI / 52 PPI default', async () => {
    const store = new LocalStore(directory); await store.initialize();
    const settings = await store.workspace();
    expect(settings.profiles).toEqual(DEFAULT_MACHINE_PROFILES);
    expect(settings.defaultProfileId).toBe(DEFAULT_MACHINE_PROFILE_ID);
    expect(settings.profiles.find(profile => profile.id === settings.defaultProfileId)).toMatchObject({ epi: 96, ppi: 52 });
    expect(settings.machineProfileCatalogVersion).toBe(MACHINE_PROFILE_CATALOG_VERSION);
    expect(settings.defaultPalette).toEqual(DEFAULT_PALETTE);
    const saved = await readFile(path.join(directory, 'workspace.json'), 'utf8');
    await store.initialize();
    expect(await readFile(path.join(directory, 'workspace.json'), 'utf8')).toBe(saved);
  });

  it('upgrades existing settings once while preserving custom profiles, defaults, palette and saved design files', async () => {
    const custom = { ...DEFAULT_PROFILE, id: 'my-loom', name: 'My loom', hooks: 3100, epi: 91, ppi: 57, notes: 'My calibrated density' };
    const previous = oldSettings([custom, DEFAULT_PROFILE]); await writeOldWorkspace(previous);
    const designPath = path.join(directory, 'designs', 'existing'); await mkdir(path.join(designPath, 'versions'), { recursive: true });
    const document = JSON.stringify({ document: { id: 'existing', profileId: custom.id }, versions: [{ id: 'saved' }] });
    const snapshot = JSON.stringify({ document: { id: 'existing', profileId: DEFAULT_PROFILE.id } });
    await writeFile(path.join(designPath, 'state.json'), document); await writeFile(path.join(designPath, 'versions', 'saved.json'), snapshot);
    const store = new LocalStore(directory); await store.initialize();
    const upgraded = await store.workspace();
    expect(upgraded).toMatchObject({ name: previous.name, defaultProfileId: previous.defaultProfileId, defaultPalette: previous.defaultPalette, machineProfileCatalogVersion: MACHINE_PROFILE_CATALOG_VERSION });
    expect(upgraded.profiles.slice(0, 2)).toEqual(previous.profiles);
    expect(upgraded.profiles.length).toBeGreaterThan(previous.profiles.length);
    await new LocalStore(directory).initialize();
    expect(await store.workspace()).toEqual(upgraded);
    expect(await readFile(path.join(designPath, 'state.json'), 'utf8')).toBe(document);
    expect(await readFile(path.join(designPath, 'versions', 'saved.json'), 'utf8')).toBe(snapshot);
  });

  it('retains matching custom profiles and edited preset IDs without adding duplicates', async () => {
    const first = DEFAULT_MACHINE_PROFILES[0], second = DEFAULT_MACHINE_PROFILES[1];
    const equivalent = { ...first, id: 'already-configured', name: 'My existing profile', notes: 'Keep these notes' };
    const customized = { ...second, name: 'Adjusted at my loom', epi: 93, ppi: 51 };
    await writeOldWorkspace(oldSettings([equivalent, customized]));
    const store = new LocalStore(directory); await store.initialize();
    const settings = await store.workspace();
    expect(settings.profiles.slice(0, 2)).toEqual([equivalent, customized]);
    expect(settings.profiles.some(profile => profile.id === first.id)).toBe(false);
    expect(settings.profiles.filter(profile => profile.id === second.id)).toEqual([customized]);
    expect(settings.profiles.filter(profile => profile.hooks === first.hooks && profile.epi === first.epi && profile.ppi === first.ppi)).toEqual([equivalent]);
  });

  it.each([MAX_MACHINE_PROFILES - 1, MAX_MACHINE_PROFILES])('upgrades a workspace with %i profiles without exceeding the limit or dropping user data', async count => {
    const profiles = Array.from({ length: count }, (_, index) => ({ ...DEFAULT_PROFILE, id: `custom-${index}`, hooks: 7000 + index, epi: 73, ppi: 37 }));
    const previous = oldSettings(profiles); await writeOldWorkspace(previous);
    const store = new LocalStore(directory); await store.initialize();
    const settings = await store.workspace();
    expect(settings.profiles).toHaveLength(MAX_MACHINE_PROFILES);
    expect(settings.profiles.slice(0, count)).toEqual(profiles);
    expect(settings.defaultProfileId).toBe(previous.defaultProfileId);
    expect(settings.machineProfileCatalogVersion).toBe(MACHINE_PROFILE_CATALOG_VERSION);
    await store.initialize(); expect(await store.workspace()).toEqual(settings);
  });

  it.each([undefined, 0, MACHINE_PROFILE_CATALOG_VERSION + 10])('keeps edits and removals across restart when a client sends catalog version %s', async clientVersion => {
    app = await createApp({ dataDir: directory });
    const settings = (await app.inject({ url: '/api/workspace', headers })).json<WorkspaceSettings>();
    const removed = settings.profiles.find(profile => profile.id !== settings.defaultProfileId)!;
    settings.profiles = settings.profiles.filter(profile => profile.id !== removed.id);
    settings.profiles[0] = { ...settings.profiles[0], name: 'My adjusted preset', ppi: 59 };
    settings.machineProfileCatalogVersion = clientVersion;
    const response = await app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: settings });
    expect(response.statusCode, response.body).toBe(200);
    const saved = response.json<WorkspaceSettings>();
    expect(saved.machineProfileCatalogVersion).toBe(MACHINE_PROFILE_CATALOG_VERSION);
    await app.close(); app = await createApp({ dataDir: directory });
    const restarted = (await app.inject({ url: '/api/workspace', headers })).json<WorkspaceSettings>();
    expect(restarted).toEqual(saved);
    expect(restarted.profiles.some(profile => profile.id === removed.id)).toBe(false);
    expect(restarted.profiles[0]).toMatchObject({ name: 'My adjusted preset', ppi: 59 });
  });
});
