import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build as viteBuild } from 'vite';
import { chromium } from 'playwright';
import { createApp } from '../apps/server/src/app';
import type { DesignRecord, DesignSummary, WorkspaceSettings } from '../packages/app-model/src';

// Isolated local app + real import worker. It never opens the user's data/jdm.
const root = process.cwd(); await mkdir(path.join(root, '.cache/gb-import-ui'), { recursive: true });
const fullSample = process.argv.includes('--full');
const runDir = await mkdtemp(path.join(root, '.cache/gb-import-ui/run-')), output = path.join(root, 'output/gb-import');
await mkdir(output, { recursive: true });
await viteBuild({ configFile: path.join(root, 'apps/web/vite.config.ts'), root: path.join(root, 'apps/web'), logLevel: 'warn', build: { outDir: path.join(runDir, 'web'), emptyOutDir: false } });
const app = await createApp({ dataDir: path.join(runDir, 'data'), staticDir: path.join(runDir, 'web') });
const address = await app.listen({ host: '127.0.0.1', port: 0 });
let executablePath: string | undefined;
for (const candidate of [process.env.JDM_BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean) as string[]) if (await access(candidate).then(() => true).catch(() => false)) { executablePath = candidate; break; }
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true }), page = await browser.newPage({ viewport: { width: 1600, height: 1150 } });
page.setDefaultTimeout(60_000); const errors: string[] = [], passed: string[] = [];
page.on('pageerror', error => errors.push(error.message));
async function api<T>(route: string): Promise<T> { const response = await fetch(address + '/api' + route); assert.equal(response.status, 200); return response.json() as Promise<T>; }
const pass = (name: string) => { passed.push(name); console.log(`PASS ${name}`); };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
try {
  const originalSettings = await api<WorkspaceSettings>('/workspace');
  await page.goto(address + '/#/import');
  await page.locator('input[type=file]').setInputFiles(path.join(root, 'sample-input/sample-1-GB.png'));
  assert.equal(await page.getByLabel('Image colors').inputValue(), 'black-white');
  await page.getByLabel('Image colors').selectOption('black-gold');
  if (!fullSample) {
    await page.getByLabel('Crop the source image').check();
    await page.getByLabel('Left', { exact: true }).fill('1200'); await page.getByLabel('Top', { exact: true }).fill('200');
    await page.getByLabel('Width', { exact: true }).fill('420'); await page.getByLabel('Height', { exact: true }).fill('480');
  }
  const importStarted = performance.now();
  await page.getByLabel('Master name').fill(fullSample ? 'Gold full sample import check' : 'Gold import crop check');
  await page.getByRole('button', { name: 'Trace image', exact: true }).click(); await page.getByText('Ready for your review.').waitFor();
  await page.screenshot({ path: path.join(output, fullSample ? 'upload-gold-full-review.png' : 'upload-gold-review.png'), fullPage: true }); pass(`Explicit B/W default and selectable gold mode with actual ${fullSample ? '3072×4096 sample' : 'sample crop'}`);
  await page.getByLabel('Image colors').selectOption('black-white');
  await page.getByText('Ready for your review.').waitFor({ state: 'hidden' }); assert.equal(await page.getByRole('button', { name: 'Create master', exact: true }).isDisabled(), true);
  await page.getByLabel('Image colors').selectOption('black-gold'); await page.getByRole('button', { name: 'Trace image', exact: true }).click(); await page.getByText('Ready for your review.').waitFor();
  pass('Changing source colors invalidates the previous trace');
  await page.getByRole('button', { name: 'Create master', exact: true }).click(); await page.locator('canvas[aria-label="Design canvas"]').waitFor(); await page.locator('.canvas-busy').waitFor({ state: 'hidden' });
  const summaries = await api<DesignSummary[]>('/designs'); assert.equal(summaries.length, 1);
  const gold = await api<DesignRecord>(`/designs/${summaries[0].id}`);
  assert.equal(gold.master.traceParams.inputMode, 'black-gold'); assert.equal(gold.master.palette.entries.length, 6); assert.deepEqual(gold.master.palette.entries[0].exportRgb, [0,0,0]);
  assert(Object.values(gold.master.geometry.edges).every(edge => edge.widthMode === 'design' && edge.strokeHidden === false && edge.width === 0 && edge.colorIndex === 1));
  assert(Object.values(gold.master.geometry.faceColors).some(face => face.colorIndex === 1)); assert(Object.values(gold.master.geometry.faceColors).every(face => face.colorIndex !== null));
  if (fullSample) { assert.equal(gold.master.source.crop, undefined); assert.deepEqual(gold.master.bounds, { w: 3072, h: 4096 }); assert(Object.keys(gold.master.geometry.nodes).length > 150_000); }
  else assert.deepEqual(gold.master.source.crop, { x: 1200, y: 200, w: 420, h: 480 });
  assert.equal(gold.master.source.widthPx, 3072); assert.equal(gold.master.source.heightPx, 4096);
  const sourceResponse = await fetch(`${address}/api/designs/${gold.id}/source`); assert.equal(digest(new Uint8Array(await sourceResponse.arrayBuffer())), digest(await readFile(path.join(root, 'sample-input/sample-1-GB.png'))));
  assert.deepEqual(await api<WorkspaceSettings>('/workspace'), originalSettings); pass('Saved gold mode/palette, filled contours without added outlines and exact original PNG; workspace unchanged');
  if (fullSample) await page.screenshot({ path: path.join(output, 'gold-full-editor.png'), fullPage: true });
  const importMs = performance.now() - importStarted;
  await page.goto(address + '/#/import'); await page.locator('input[type=file]').setInputFiles(path.join(root, 'eval/golden/input/01-square.png'));
  assert.equal(await page.getByLabel('Image colors').inputValue(), 'black-white');
  await page.getByRole('button', { name: 'Trace image', exact: true }).click(); await page.getByText('Ready for your review.').waitFor();
  await page.getByRole('button', { name: 'Create master', exact: true }).click(); await page.locator('canvas[aria-label="Design canvas"]').waitFor();
  const bwSummary = (await api<DesignSummary[]>('/designs')).find(item => item.id !== gold.id)!; const bw = await api<DesignRecord>(`/designs/${bwSummary.id}`);
  assert.equal(bw.master.traceParams.inputMode, 'black-white'); assert.deepEqual(bw.master.palette, originalSettings.defaultPalette); assert(Object.values(bw.master.geometry.edges).every(edge => edge.colorIndex === 5 && edge.widthMode === 'design' && edge.strokeHidden === false));
  pass('B/W import still uses original workspace palette and visible outline strokes');
  assert.deepEqual(errors, []); await writeFile(path.join(output, fullSample ? 'ui-full-report.json' : 'ui-report.json'), JSON.stringify({ passed, errors, importMs, nodes: Object.keys(gold.master.geometry.nodes).length, contours: Object.keys(gold.master.geometry.edges).length }, null, 2));
} catch (error) { await page.screenshot({ path: path.join(output, 'upload-failure.png'), fullPage: true }); throw error; }
finally { await browser.close(); await app.close(); }
