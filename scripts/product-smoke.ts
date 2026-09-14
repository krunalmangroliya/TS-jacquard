import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createApp } from '../apps/server/src/app';
import type { DesignRecord, DesignSummary, ExportSummary, VersionSummary, WorkspaceSettings } from '../packages/app-model/src';
import { resolveSize } from '../packages/core/src/size';

// Real application, API, browser workers, disk writes and export worker. Every run
// has its own storage and build directory; the user's library is never opened.
const root = process.cwd();
await mkdir(path.join(root, '.cache/product-smoke'), { recursive: true });
const runDir = await mkdtemp(path.join(root, '.cache/product-smoke/run-'));
const outputDir = path.join(root, 'output/product-smoke');
await mkdir(outputDir, { recursive: true });
await viteBuild({ configFile: path.join(root, 'apps/web/vite.config.ts'), root: path.join(root, 'apps/web'), logLevel: 'warn', build: { outDir: path.join(runDir, 'web'), emptyOutDir: false } });
await build({ entryPoints: [path.join(root, 'apps/server/src/export-worker.ts')], outfile: path.join(runDir, 'export-worker.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
const app = await createApp({ dataDir: path.join(runDir, 'data'), staticDir: path.join(runDir, 'web'), exportWorkerPath: path.join(runDir, 'export-worker.mjs') });
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const candidates = [process.env.JDM_BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean) as string[];
let executablePath: string | undefined;
for (const candidate of candidates) if (await access(candidate).then(() => true).catch(() => false)) { executablePath = candidate; break; }
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(20_000);
const errors: string[] = [], steps: string[] = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => void dialog.accept());
async function api<T>(url: string): Promise<T> { const response = await fetch(address + '/api' + url); if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`); return await response.json() as T; }
async function until<T>(label: string, read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 20_000): Promise<T> { const start = Date.now(); do { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() - start < timeout); throw new Error(`Timed out: ${label}`); }
const record = (id: string) => api<DesignRecord>(`/designs/${id}`);
const ready = async (target = page) => { await target.locator('canvas[aria-label="Design canvas"]').waitFor(); await target.locator('.canvas-busy').waitFor({ state: 'hidden' }); await target.locator('.save-indicator').filter({ hasText: 'Saved on this PC' }).waitFor(); };
const selectedId = async () => (await page.locator('[aria-label="Master or size"]').inputValue());
const step = (name: string) => { steps.push(name); console.log(`PASS ${name}`); };
async function center(target = page) { const box = await target.locator('canvas[aria-label="Design canvas"]').boundingBox(); assert(box); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
async function fill(index: number) { await page.getByRole('button', { name: 'design', exact: true }).click(); await page.locator('.palette-grid button').nth(index).click(); await page.getByRole('button', { name: 'Fill', exact: true }).click(); const point = await center(); await page.mouse.click(point.x, point.y); }
async function open(id: string) { await page.getByLabel('Master or size').selectOption(id); await until('opened design', selectedId, value => value === id); await ready(); }

try {
  await page.goto(address);
  await page.getByRole('button', { name: 'New master', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(path.join(root, 'eval/golden/input/01-square.png'));
  await page.getByLabel('Master name').fill('Product smoke square');
  await page.getByRole('button', { name: 'Trace image', exact: true }).click();
  await page.getByText('Ready for your review.').waitFor();
  await page.getByRole('button', { name: 'Create master', exact: true }).click();
  await ready(); const masterId = await selectedId();
  const imported = await record(masterId);
  assert.equal(imported.master.source.widthPx, 256);
  assert(Object.values(imported.master.geometry.faceColors).some(color => color.colorIndex === null));
  assert(Object.values(imported.master.geometry.edges).every(edge => edge.widthMode === 'design' && edge.width > 0 && edge.colorIndex === 5));
  step('PNG import, real trace worker, source-width strokes and unassigned fills');

  await fill(1);
  const colored = await until('amber fill autosaved', () => record(masterId), value => Object.values(value.master.geometry.faceColors).some(color => color.colorIndex === 1));
  await ready(); await page.reload(); await ready();
  assert.deepEqual((await record(masterId)).master.geometry.faceColors, colored.master.geometry.faceColors);
  step('Fill, disk autosave and reload');

  await page.getByRole('button', { name: 'history', exact: true }).click();
  await page.getByLabel('Version note').fill('Amber checkpoint');
  await page.locator('.inspector').getByRole('button', { name: 'Save version', exact: true }).click();
  const checkpoints = await until('saved checkpoint', () => api<VersionSummary[]>(`/designs/${masterId}/versions`), value => value.some(version => version.note === 'Amber checkpoint'));
  const checkpoint = checkpoints.find(version => version.note === 'Amber checkpoint')!;
  await ready(); await fill(2);
  await until('red fill autosaved', () => record(masterId), value => Object.values(value.master.geometry.faceColors).some(color => color.colorIndex === 2));
  await ready(); await page.getByRole('button', { name: 'history', exact: true }).click();
  await page.locator('.version-list article').filter({ has: page.getByText('Amber checkpoint', { exact: true }) }).getByRole('button', { name: 'Restore', exact: true }).click();
  const restored = await until('version restored', () => record(masterId), value => value.master.version > checkpoint.version && Object.values(value.master.geometry.faceColors).some(color => color.colorIndex === 1));
  await page.locator('.document-title span').filter({ hasText: new RegExp(`v${restored.master.version}$`) }).waitFor();
  await ready(); assert(!Object.values(restored.master.geometry.faceColors).some(color => color.colorIndex === 2));
  step('Named version, subsequent edit and version restore');

  const readOnlyPage = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  readOnlyPage.setDefaultTimeout(20_000);
  readOnlyPage.on('pageerror', error => errors.push(error.message));
  await readOnlyPage.goto(`${address}/#/design/${masterId}`);
  await readOnlyPage.locator('.save-indicator').filter({ hasText: 'Read-only' }).waitFor().catch(async error => { await readOnlyPage.screenshot({ path: path.join(outputDir, 'readonly-failure.png'), fullPage: true }); throw error; });
  const beforeLocked = await record(masterId), point = await center(readOnlyPage);
  await readOnlyPage.getByRole('button', { name: 'Fill', exact: true }).click();
  await readOnlyPage.mouse.click(point.x, point.y);
  assert.equal((await record(masterId)).revision, beforeLocked.revision);
  await readOnlyPage.close(); step('Second browser tab is read-only');

  await page.getByRole('button', { name: 'output', exact: true }).click();
  await page.getByLabel('Width', { exact: true }).fill('64');
  await page.getByLabel('New size name').fill('64 hook smoke');
  await page.getByRole('button', { name: 'Create size variant', exact: true }).click();
  await until('size opened', selectedId, value => value !== masterId); await ready();
  const sizeId = await selectedId(), sizeRecord = await record(sizeId), settings = await api<WorkspaceSettings>('/workspace');
  assert.equal(sizeRecord.kind, 'size'); assert.equal(sizeRecord.masterId, masterId);
  const profile = settings.profiles.find(profile => profile.id === sizeRecord.profileId)!;
  const size = resolveSize(sizeRecord.master.bounds, profile, sizeRecord.sizeInput);
  assert.equal(size.widthPx, 64); step('Create independent size with EPI/PPI dimensions');

  await page.getByRole('button', { name: 'design', exact: true }).click();
  await page.locator('.palette-grid button').nth(2).click();
  await page.getByRole('button', { name: 'Pixel pencil', exact: true }).click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  const box = await page.locator('canvas[aria-label="Design canvas"]').boundingBox(); assert(box);
  const physicalHeight = size.heightPx * profile.epi / profile.ppi, scale = Math.min((box.width - 64) / size.widthPx, (box.height - 64) / physicalHeight);
  const pixelPoint = (x: number, y: number) => ({ x: box.x + (box.width - size.widthPx * scale) / 2 + (x + .5) * scale, y: box.y + (box.height - physicalHeight * scale) / 2 + (y + .5) * scale * profile.epi / profile.ppi });
  const first = pixelPoint(20, 20), last = pixelPoint(29, 24);
  await page.mouse.click(first.x, first.y);
  await until('first pixel saved', () => record(sizeId), value => value.pixelOverrides.some(pixel => pixel.x === 20 && pixel.y === 20 && pixel.colorIndex === 2)); await ready();
  await page.keyboard.down('Shift'); await page.mouse.click(last.x, last.y); await page.keyboard.up('Shift');
  const pixels = await until('Shift pixel line saved', () => record(sizeId), value => value.pixelOverrides.length === 10);
  assert(pixels.pixelOverrides.every(pixel => pixel.colorIndex === 2));
  for (let x = 20; x <= 29; x++) assert(pixels.pixelOverrides.some(pixel => pixel.x === x));
  await ready(); await page.getByLabel('Cleanup', { exact: true }).check(); await page.getByLabel('Overrides', { exact: true }).check();
  await page.keyboard.down('Space'); await page.mouse.move(first.x, first.y); await page.mouse.down(); await page.mouse.move(first.x + 15, first.y + 10); await page.mouse.up(); await page.keyboard.up('Space');
  await ready(); assert.deepEqual((await record(sizeId)).pixelOverrides, pixels.pixelOverrides, 'Panning from a focused toolbar checkbox must not paint');
  await page.screenshot({ path: path.join(outputDir, 'pixel-size.png'), fullPage: true });
  step('Pixel pencil, Shift straight line and overlay pan');

  await page.getByRole('button', { name: 'output', exact: true }).click();
  const downloadPromise = page.waitForEvent('download'); await page.locator('.inspector').getByRole('button', { name: 'Export BMP', exact: true }).click();
  const download = await downloadPromise; await download.saveAs(path.join(outputDir, 'pixel-line.bmp'));
  const exports = await api<ExportSummary[]>(`/designs/${sizeId}/exports`); assert(exports.length);
  const bmp = new Uint8Array(await (await fetch(`${address}/api/designs/${sizeId}/exports/${exports[0].id}/bmp`)).arrayBuffer()), bmpView = new DataView(bmp.buffer);
  assert.equal(bmpView.getUint16(28, true), 8); assert.equal(bmpView.getInt32(18, true), size.widthPx); assert.equal(bmpView.getInt32(22, true), size.heightPx);
  const offset = bmpView.getUint32(10, true), stride = Math.ceil(size.widthPx / 4) * 4;
  for (const pixel of pixels.pixelOverrides) assert.equal(bmp[offset + (size.heightPx - 1 - pixel.y) * stride + pixel.x], pixel.colorIndex);
  step('Real export worker and byte-verified indexed BMP pixels');

  await page.getByRole('button', { name: 'design', exact: true }).click();
  await page.locator('.palette-grid button').nth(2).click(); await page.getByText('Merge selected color…', { exact: true }).click();
  await page.getByLabel('Merge into color').selectOption('1');
  await page.getByRole('button', { name: 'Merge and remove color 2', exact: true }).click();
  await until('palette merge saved', () => record(sizeId), value => value.master.palette.entries.length === 5 && value.pixelOverrides.every(pixel => pixel.colorIndex === 1)); await ready();
  await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click();
  await until('palette merge undone', () => record(sizeId), value => value.master.palette.entries.length === 6 && value.pixelOverrides.every(pixel => pixel.colorIndex === 2)); await ready();
  step('Palette merge updates overrides; Undo restores both');

  await open(masterId); await fill(3);
  await until('current master changed', () => record(masterId), value => Object.values(value.master.geometry.faceColors).some(color => color.colorIndex === 3)); await ready();
  await page.locator('.editor-header').getByRole('button', { name: 'Save version', exact: true }).click();
  const currentMaster = await until('new master version', () => record(masterId), value => value.master.version > restored.master.version); await ready();
  await open(sizeId); await page.getByRole('button', { name: 'output', exact: true }).click();
  await page.getByRole('button', { name: 'Review update from current master →', exact: true }).click();
  await page.getByRole('button', { name: 'Keep updated size', exact: true }).waitFor();
  await page.getByRole('button', { name: 'design', exact: true }).click();
  await page.locator('.section-heading').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Color 2 name', { exact: true }).fill('Smoke scarlet');
  await page.getByRole('button', { name: 'Apply colors', exact: true }).click();
  await until('new palette edit saved during comparison', () => record(sizeId), value => value.master.palette.entries[2].name === 'Smoke scarlet');
  await page.getByRole('button', { name: 'Review latest edits', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Keep updated size', exact: true }).count(), 0, 'A stale candidate must not remain directly acceptable');
  await page.getByRole('button', { name: 'Review latest edits', exact: true }).click();
  await page.getByRole('button', { name: 'Keep updated size', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Proposed updated size', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.compare-grid canvas').length === 2);
  const comparisonRatios = await page.locator('.compare-grid canvas').evaluateAll(canvases => canvases.map(canvas => { const box = canvas.getBoundingClientRect(); return box.width / box.height; }));
  for (const ratio of comparisonRatios) assert(Math.abs(ratio - size.widthIn / size.heightIn) < .01, 'Comparison must preserve physical EPI/PPI proportions');
  await page.screenshot({ path: path.join(outputDir, 'rebase-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Keep updated size', exact: true }).click();
  const rebased = await until('review accepted', () => record(sizeId), value => value.baseMasterVersion === currentMaster.master.version && Object.values(value.master.geometry.faceColors).some(color => color.colorIndex === 3));
  assert.deepEqual(rebased.pixelOverrides, pixels.pixelOverrides); assert.equal(rebased.master.palette.entries[2].name, 'Smoke scarlet'); await ready();
  step('Review rebase against current master and retain size pixel edits');
  step('Rebase candidate refresh retains palette edits made during comparison');

  await page.getByTitle('Back to library', { exact: true }).click();
  await page.getByRole('heading', { name: 'Your design library', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Archive 64 hook smoke', exact: true }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await until('size archived', () => api<DesignSummary[]>('/designs'), value => !value.some(design => design.id === sizeId));
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await page.getByRole('heading', { name: 'Archived designs', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Restore to library', exact: true }).click();
  await until('size restored to library', () => api<DesignSummary[]>('/designs'), value => value.some(design => design.id === sizeId));
  await page.getByRole('button', { name: 'Back to library', exact: true }).first().click();
  await page.getByRole('button', { name: 'Archive 64 hook smoke', exact: true }).waitFor();
  const unarchived = await record(sizeId); assert.deepEqual(unarchived.pixelOverrides, rebased.pixelOverrides); assert.equal(unarchived.master.palette.entries[2].name, 'Smoke scarlet');
  await page.screenshot({ path: path.join(outputDir, 'restored-library.png'), fullPage: true });
  step('Archive and restore size through Library without losing edits');
  assert.deepEqual(errors, []);
  const report = { browser: await browser.version(), steps, masterId, sizeId, size: { widthPx: size.widthPx, heightPx: size.heightPx }, verifiedBmpPixels: pixels.pixelOverrides.length, isolatedDataDirectory: path.join(runDir, 'data'), browserErrors: errors };
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  for (const name of ['failure.txt', 'failure.png', 'readonly-failure.png']) await rm(path.join(outputDir, name), { force: true });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'failure.txt'), `${String(error)}\nBrowser errors: ${errors.join('\n')}\nPassed: ${steps.join(', ')}\nStorage: ${runDir}\n`);
  throw error;
} finally { await browser.close(); await app.close(); }
