import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateMaster } from '../packages/core/src/schemas';
import type { DesignRecord, DesignSummary } from '../packages/app-model/src';

// Explicit local fixture import. Existing active or archived tagged records are
// reused; this script never changes an existing design or the supplied source.
const origin = 'http://127.0.0.1:4317', tag = 'supplied-gold-sample', directory = path.resolve('output/gb-import');
async function get<T>(route: string): Promise<T> { const response = await fetch(origin + route); if (response.status !== 200) throw new Error(`${route}: ${response.status} ${await response.text()}`); return response.json() as Promise<T>; }
const health = await get<{ ok: boolean; application: string }>('/api/health'); assert(health.ok && health.application === 'JDM');
const records = [...await get<DesignSummary[]>('/api/designs'), ...await get<DesignSummary[]>('/api/archived')];
const existing = records.find(record => record.tags.includes(tag));
if (existing) console.log(JSON.stringify({ reused: true, id: existing.id, name: existing.name }));
else {
  const master = validateMaster(JSON.parse(await readFile(path.join(directory, 'sample-1-GB.master.json'), 'utf8')));
  master.name = 'Sample 1 GB · Black & Gold'; master.tags = [...new Set([...master.tags, tag])];
  const source = await readFile(path.resolve('sample-input/sample-1-GB.png')), thumbnail = await readFile(path.join(directory, 'source-preview.png'));
  const response = await fetch(origin + '/api/designs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ master, name: master.name, sourcePngBase64: source.toString('base64'), thumbnailPngBase64: thumbnail.toString('base64') }) });
  if (response.status !== 200) throw new Error(`Import failed: ${response.status} ${await response.text()}`);
  const created = await response.json() as DesignRecord, persisted = await get<DesignRecord>(`/api/designs/${created.id}`);
  assert.equal(persisted.master.traceParams.inputMode, 'black-gold', 'The running server must preserve the input mode; rebuild it before seeding.');
  const savedSource = await fetch(`${origin}/api/designs/${created.id}/source`); assert.equal(savedSource.status, 200);
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(new Uint8Array(await savedSource.arrayBuffer())), digest(source));
  const result = { id: created.id, name: created.name, revision: created.revision, inputMode: created.master.traceParams.inputMode, nodes: Object.keys(created.master.geometry.nodes).length, contours: Object.keys(created.master.geometry.edges).length, originalSourceSha256: digest(source) };
  await writeFile(path.join(directory, 'seeded-design.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
