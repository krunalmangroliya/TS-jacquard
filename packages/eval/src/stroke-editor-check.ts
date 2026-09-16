import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { DEFAULT_PALETTE, DEFAULT_PROFILE, type Geometry, type Master } from '../../core/src/types';
import { buildPlanarMap } from '../../core/src/topology';
import { materializeGeometry } from '../../core/src/materialize';
import { render } from '../../core/src/render';
import { encodeBmp } from '../../core/src/bmp';
import { validateMaster } from '../../core/src/schemas';
import { writeStrokeEditor } from './stroke-editor';

type EditorState = { ready: boolean; busy: boolean; selection: string | null; hiddenIds: string[]; revision: number; renderedRevision: number; topologyBuilds: number; widthPx: number; heightPx: number; undoCount: number; redoCount: number; edgeIds: string[] };
type Hook = { getState(): EditorState; selectEdge(id: string): void; screenPoint(id: string): { x: number; y: number } };
const state = (page: Page): Promise<EditorState> => page.evaluate(() => (window as unknown as { __strokeEditor: Hook }).__strokeEditor.getState());
const settled = (page: Page): Promise<void> => page.waitForFunction(() => { const s = (window as unknown as { __strokeEditor?: Hook }).__strokeEditor?.getState(); return s?.ready && !s.busy && s.revision === s.renderedRevision; }, undefined, { timeout: 60_000 }).then(() => {});

/** Reusable file:// smoke check. Uses an installed browser supplied by the caller; no downloads. */
export async function verifyStrokeEditorSmoke(directory: string, executablePath = chromium.executablePath()): Promise<{ html: string; checks: number; topologyBuilds: number }> {
  const geometry: Geometry = { nodes: {}, edges: {}, faceColors: {} };
  const paths = { border: [[10, 10], [90, 10], [90, 90], [10, 90], [10, 10]], editable: [[25, 35], [75, 35]], locked: [[25, 65], [75, 65]] };
  for (const [id, points] of Object.entries(paths)) {
    const nodeIds = points.map(([x, y], i) => { const nodeId = `${id}-${i}`; geometry.nodes[nodeId] = { id: nodeId, p: { x, y }, kind: 'corner' }; return nodeId; });
    geometry.edges[id] = { id, nodeIds, segments: points.slice(1).map(() => ({})), width: 2, widthMode: 'design', colorIndex: 5, strokeHidden: false, z: 0 };
  }
  const bounds = { w: 100, h: 100 }, faces = buildPlanarMap(geometry, bounds, { type: 'none' }).faces;
  geometry.faceColors = Object.fromEntries(faces.map(face => [face.id, { colorIndex: face.outer ? 1 : 0, ref: face.ref }]));
  const master: Master = validateMaster({
    schemaVersion: 1, id: 'stroke-editor-smoke', workspaceId: 'local-test', name: 'Stroke inspector test', tags: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1, bounds, repeat: { type: 'none' },
    palette: { entries: DEFAULT_PALETTE.entries.slice(0, 6) }, geometry,
    objects: Object.keys(paths).map(id => ({ id, name: id, edgeIds: [id], locked: id === 'locked', hidden: false })),
    source: { fileId: 'synthetic-smoke', widthPx: 100, heightPx: 100 },
    traceParams: { threshold: 'otsu', invert: false, minSpeckArea: 0, gapClosePx: 0, spurPrunePx: 0, simplifyTolerance: 1, fitMaxError: 1.5, cornerAngleDeg: 60 },
  });
  const rules = { minRegionPx: 0, minThicknessPx: 0, removeCheckerboard: false, connectVisibleEdges4: false };
  const html = await writeStrokeEditor(directory, master, { widthPx: 200, heightPx: 160, rules });
  const browser = await chromium.launch({ executablePath, headless: true });
  const errors: string[] = []; let checks = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(pathToFileURL(html).href); await settled(page);
    assert.equal((await state(page)).topologyBuilds, 1); checks++;
    assert.equal(await page.locator('.swatch').count(), 6); checks++;
    async function download(id: string, output: string): Promise<Buffer> {
      const event = page.waitForEvent('download'); await page.locator(`#${id}`).click(); const file = await event;
      const filePath = path.join(directory, output); await file.saveAs(filePath); return readFile(filePath);
    }
    const untouched = JSON.parse((await download('download-master', 'untouched-master.json')).toString()) as Master;
    assert.deepEqual(untouched, master); checks++;
    const point = await page.evaluate(() => (window as unknown as { __strokeEditor: Hook }).__strokeEditor.screenPoint('editable'));
    await page.mouse.click(point.x + 12, point.y); assert.equal((await state(page)).selection, 'editable'); checks++;
    await page.locator('#hide-stroke').click(); await settled(page);
    assert.deepEqual((await state(page)).hiddenIds, ['editable']); checks++;
    await page.keyboard.press('Escape'); assert.equal((await state(page)).selection, null);
    await page.locator('#hidden-list button[data-edge-id="editable"]').click();
    assert.equal((await state(page)).selection, 'editable'); assert.equal(await page.locator('#restore-stroke').isEnabled(), true); checks++;
    await page.locator('#restore-stroke').click(); await settled(page); assert.deepEqual((await state(page)).hiddenIds, []); checks++;
    await page.locator('#undo').click(); await settled(page); assert.deepEqual((await state(page)).hiddenIds, ['editable']); checks++;
    await page.locator('#redo').click(); await settled(page); assert.deepEqual((await state(page)).hiddenIds, []); checks++;
    await page.locator('#hide-stroke').click(); await settled(page);
    await page.evaluate(() => (window as unknown as { __strokeEditor: Hook }).__strokeEditor.selectEdge('locked'));
    assert.equal(await page.locator('#hide-stroke').isDisabled(), true); await page.keyboard.press('Delete');
    assert.deepEqual((await state(page)).hiddenIds, ['editable']); checks++;
    await page.locator('#output-width').fill('240'); await page.locator('#output-height').fill('192'); await page.locator('#apply-size').click(); await settled(page);
    assert.equal((await state(page)).widthPx, 240); assert.equal((await state(page)).heightPx, 192); checks++;
    const edited = validateMaster(JSON.parse((await download('download-master', 'edited-master.json')).toString()));
    assert.equal(edited.version, 2); assert.notEqual(edited.updatedAt, master.updatedAt); assert.equal(edited.geometry.edges.editable.strokeHidden, true);
    assert.deepEqual(edited.geometry.nodes, master.geometry.nodes); assert.deepEqual(edited.geometry.faceColors, master.geometry.faceColors); assert.deepEqual(edited.objects, master.objects);
    assert.deepEqual(Object.keys(edited.geometry.edges), Object.keys(master.geometry.edges)); assert.equal(edited.geometry.edges.editable.width, 2); assert.equal(edited.geometry.edges.editable.widthMode, 'design'); checks++;
    const actual = await download('download-bmp', 'edited.bmp'), materialized = materializeGeometry(edited);
    const result = render(materialized.geometry, materialized.faces, edited.bounds, edited.palette, 240, 192, rules, [], edited.repeat, edited.raster);
    assert.deepEqual(actual, Buffer.from(encodeBmp(result.grid, 240, 192, edited.palette, DEFAULT_PROFILE))); checks++;
    const final = await state(page); assert.equal(final.topologyBuilds, 1); assert.deepEqual(errors, []); checks++;
    await page.screenshot({ path: path.join(directory, 'stroke-editor-smoke.png'), fullPage: true });
    return { html, checks, topologyBuilds: final.topologyBuilds };
  } finally { await browser.close(); }
}
