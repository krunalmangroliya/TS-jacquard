import { createHash } from 'node:crypto';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { exportMaster } from './pipeline';
import { DEFAULT_PROFILE, DEFAULT_RULES } from '../../core/src/types';
import { profileSchema, ruleSchema, validateMaster } from '../../core/src/schemas';
import { materializeGeometry } from '../../core/src/materialize';
import type { MachineProfile, RuleConfig } from '../../core/src/types';

export interface DiagnosticCrop { x: number; y: number; width: number; height: number }
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function browserExecutable(): Promise<string> {
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter((root): root is string => !!root);
  const candidates = roots.flatMap(root => [path.join(root, 'Microsoft/Edge/Application/msedge.exe'), path.join(root, 'Google/Chrome/Application/chrome.exe')]);
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome', chromium.executablePath());
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* Only use installed browsers. */ } }
  throw new Error('Diagnostic exports and HTML are ready, but screenshots require installed Edge, Chrome, or Playwright Chromium. No browser was downloaded.');
}

/** Optional expert diagnostic. It never changes the saved master or the normal export pipeline. */
export async function createDetailDiagnostic(reviewDirectory: string, widthPx = 2400, requestedCrop?: DiagnosticCrop) {
  if (!Number.isSafeInteger(widthPx) || widthPx < 1) throw new Error('Diagnostic width must be a positive integer.');
  const directory = path.resolve(reviewDirectory), originalBytes = await readFile(path.join(directory, 'master.json'));
  // The normal master validator also enforces the indexed palette limit.
  const original = validateMaster(JSON.parse(originalBytes.toString('utf8')));
  await access(path.join(directory, 'source.png'));
  const files = (await readdir(directory)).filter(name => /^size-.*\.json$/i.test(name)).sort();
  let profile: MachineProfile = DEFAULT_PROFILE, rules: RuleConfig = DEFAULT_RULES;
  for (const file of files) {
    const sidecar = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    if (sidecar.widthPx !== widthPx) continue;
    profile = profileSchema.parse(sidecar.profile); rules = ruleSchema.parse(sidecar.rules); break;
  }
  const master = original, hiddenMaster = structuredClone(original);
  for (const edge of Object.values(hiddenMaster.geometry.edges)) edge.strokeHidden = true;
  const currentEdges = Object.values(master.geometry.edges), visibleEdges = currentEdges.filter(edge => edge.width > 0 && !edge.strokeHidden);
  const designEdges = visibleEdges.filter(edge => edge.widthMode === 'design'), outputEdges = visibleEdges.length - designEdges.length;
  const baselineStem = `detail-hidden-${widthPx}px`, diagnosticStem = `detail-source-strokes-${widthPx}px`, metadataStem = `detail-comparison-${widthPx}px`;
  // Stroke visibility does not affect faces. Reuse one reconciled topology for
  // both newly rendered exports, changing only the comparison's visible ink.
  const prepared = materializeGeometry(master);
  const hiddenPrepared = { ...prepared, geometry: { ...prepared.geometry, edges: Object.fromEntries(Object.entries(prepared.geometry.edges).map(([id, edge]) => [id, { ...edge, strokeHidden: true }])) } };
  const hiddenResult = await exportMaster(hiddenMaster, profile, { mode: 'grid', widthPx, linkAspect: true }, path.join(directory, `${baselineStem}.bmp`), rules, [], hiddenPrepared);
  const result = await exportMaster(master, profile, { mode: 'grid', widthPx, linkAspect: true }, path.join(directory, `${diagnosticStem}.bmp`), rules, [], prepared);
  let styledDifferences = 0;
  for (let p = 0; p < result.grid.length; p++) if (result.grid[p] !== hiddenResult.grid[p]) styledDifferences++;
  const displayWidth = result.widthPx, displayHeight = result.heightPx * profile.epi / profile.ppi;
  const sx = displayWidth / master.bounds.w, sy = displayHeight / master.bounds.h;
  const defaultCropWidth = Math.min(450, displayWidth), defaultCropHeight = Math.min(750, displayHeight);
  const crop = requestedCrop ?? {
    x: Math.max(0, (displayWidth - defaultCropWidth) / 2) / sx,
    y: Math.max(0, (displayHeight - defaultCropHeight) / 2) / sy,
    width: defaultCropWidth / sx, height: defaultCropHeight / sy,
  };
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > master.bounds.w || crop.y + crop.height > master.bounds.h) {
    throw new Error('Crop must be x,y,width,height in source design units and lie inside the source image.');
  }
  const cropWidth = Math.round(crop.width * sx), cropHeight = Math.round(crop.height * sy);
  const metadata = {
    kind: 'Stroke visibility comparison only; test palette, not approved yarn/weave assignments',
    originalMasterSha256: hash(originalBytes), originalMasterFile: 'master.json', hiddenComparisonFile: `${baselineStem}.bmp`, currentStrokesFile: `${diagnosticStem}.bmp`,
    hiddenComparisonOperation: 'Set strokeHidden=true on every edge of an in-memory copy; preserve widths, colors, curves, boundaries, and face assignments',
    currentOutputOperation: 'Render the saved master with its original stroke widths, modes, colors, and visibility',
    paletteEntries: master.palette.entries.length, totalEdges: currentEdges.length, currentVisibleStrokes: visibleEdges.length,
    designWidthStrokes: designEdges.length, outputWidthStrokes: outputEdges, pixelsDifferentFromHiddenComparison: styledDifferences,
    hiddenComparisonColorsUsed: hiddenResult.report.colorsUsed, currentColorsUsed: result.report.colorsUsed,
    cropSourceDesignUnits: crop, cropDisplayPixels: { width: cropWidth, height: cropHeight }, verticalPixelScale: profile.epi / profile.ppi,
  };
  await writeFile(path.join(directory, `${metadataStem}.diagnostic.json`), `${JSON.stringify(metadata, null, 2)}\n`);
  const currentTitle = outputEdges ? 'Current saved stroke widths' : 'Current source-width strokes';
  const panels = [['Source line art', 'source.png', 'source'], ['All strokes hidden / comparison only', `${baselineStem}.png`, 'hidden'], [currentTitle, `${diagnosticStem}.png`, 'current']];
  const format = (value: number): string => value.toLocaleString('en-US');
  const overviewWidth = Math.min(280, 420 * displayWidth / displayHeight), overviewHeight = overviewWidth * displayHeight / displayWidth;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(master.name)} — stroke visibility comparison</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f4f1e9;color:#28342f;font:15px/1.5 system-ui,sans-serif}main{max-width:${Math.max(1490, (cropWidth + 26) * 3 + 108)}px;margin:auto;padding:32px}h1{font:38px Georgia,serif;margin:0 0 14px}h2{font-size:19px}p{max-width:1120px}.notice{padding:16px;background:#fff5d6;border-left:4px solid #ad873d}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}.card{background:white;padding:12px;border:1px solid #d9ddd4;overflow:auto}.whole{display:flex;justify-content:center;height:420px}.whole img{width:${overviewWidth}px;height:${overviewHeight}px;object-fit:fill}.crop{position:relative;width:${cropWidth}px;height:${cropHeight}px;overflow:hidden;background:white}.crop img{position:absolute;left:-${crop.x * sx}px;top:-${crop.y * sy}px;width:${displayWidth}px;height:${displayHeight}px;max-width:none;image-rendering:pixelated}a{color:#275744}.fine{font-size:13px;color:#57665e}footer{margin-top:24px;padding-top:16px;border-top:1px solid #bfc9bd}
    </style></head><body><main><h1>${escapeHtml(master.name)} / stroke visibility comparison</h1><p class="notice"><b>Optional visibility comparison.</b> The middle image hides all stroke ink for comparison only. The right image uses the saved master's current ${format(visibleEdges.length)} visible strokes with their original widths, colors, and visibility settings. Both use the same ${master.palette.entries.length}-color palette and the same boundaries and face fills. The saved original master is unchanged.</p><p>The normal workflow preserves source-width strokes. Hiding a stroke can remove hatching or an outline while retaining separately editable filled regions. This comparison helps identify details to keep, hide, or recolor selectively; it does not approve yarn colors or weave assignments.</p><div class="grid">${panels.map(([title, src]) => `<article class="card"><h2>${title}</h2><div class="whole"><img src="${escapeHtml(src)}" alt="${title}"></div></article>`).join('')}</div><h2>Aligned detail / 100% horizontal output-pixel crop</h2><p class="fine">Both outputs use ${result.widthPx} hooks × ${result.heightPx} picks (${result.widthIn.toFixed(2)} × ${result.heightIn.toFixed(2)} inches with ${profile.epi} EPI / ${profile.ppi} PPI). One horizontal output pixel is one CSS pixel; vertical pixels display ${(profile.epi / profile.ppi).toFixed(2)}× tall for physical proportion. The source is aligned to the same design coordinates. Crop: ${[crop.x, crop.y, crop.width, crop.height].map(n => n.toFixed(1)).join(', ')} source units.</p><div class="grid">${panels.map(([title, src, id]) => `<article class="card"><h2>${title}</h2><div class="crop" data-crop="${id}"><img src="${escapeHtml(src)}" alt="Aligned detail: ${title}"></div></article>`).join('')}</div><footer><p>${format(styledDifferences)} output pixels differ between hidden-stroke and current-stroke exports after rendering and cleanup. This is not a count of corrected errors or saved manual edits.</p><a href="${baselineStem}.bmp">Hidden-stroke comparison BMP</a> · <a href="${diagnosticStem}.bmp">Current-stroke BMP</a> · <a href="${diagnosticStem}.png">Current PNG</a> · <a href="${diagnosticStem}.json">Export report</a> · <a href="${metadataStem}.diagnostic.json">Comparison metadata</a> · <a href="review.html">Sample review</a></footer></main></body></html>`;
  await writeFile(path.join(directory, 'detail-comparison.html'), html, 'utf8');
  const browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: Math.max(1540, (cropWidth + 26) * 3 + 108), height: 1000 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.join(directory, 'detail-comparison.html')).href);
    await page.waitForFunction(() => Array.from(document.images).every(img => img.complete && img.naturalWidth > 0));
    await page.screenshot({ path: path.join(directory, 'detail-comparison-screenshot.png'), fullPage: true });
    for (const [, , id] of panels) await page.locator(`[data-crop="${id}"]`).screenshot({ path: path.join(directory, `detail-crop-${id}.png`) });
  } finally { await browser.close(); }
  if (hash(await readFile(path.join(directory, 'master.json'))) !== metadata.originalMasterSha256) throw new Error('Saved master changed during the diagnostic; check for a concurrent import.');
  return { paletteEntries: master.palette.entries.length, currentVisibleStrokes: visibleEdges.length, designWidthStrokes: designEdges.length, pixelsDifferent: styledDifferences, hiddenRenderMs: hiddenResult.renderMs, currentRenderMs: result.renderMs, hiddenOmittedRegionMarkers: hiddenResult.report.smallFacesRemoved.length, currentOmittedRegionMarkers: result.report.smallFacesRemoved.length, report: path.join(directory, 'detail-comparison.html') };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { width: { type: 'string', default: '2400' }, crop: { type: 'string' } } });
  if (positionals.length !== 1) throw new Error('Usage: tsx packages/eval/src/detail-diagnostic.ts REVIEW_DIRECTORY [--width 2400] [--crop x,y,width,height] (crop in source design units)');
  let crop: DiagnosticCrop | undefined;
  if (values.crop) {
    const coordinates = values.crop.split(',').map(Number);
    if (coordinates.length !== 4) throw new Error('--crop requires four comma-separated source coordinates: x,y,width,height.');
    const [x, y, width, height] = coordinates; crop = { x, y, width, height };
  }
  console.log(JSON.stringify(await createDetailDiagnostic(positionals[0], Number(values.width), crop), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
