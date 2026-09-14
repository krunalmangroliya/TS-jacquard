import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DEFAULT_PROFILE, DEFAULT_RULES, type MachineProfile, type Master, type RuleConfig } from '../../core/src/types';
import { resolveSize } from '../../core/src/size';
import { profileSchema, ruleSchema, validateMaster } from '../../core/src/schemas';
import { escapeHtml } from './io';

export interface StrokeEditorOptions {
  profile?: MachineProfile;
  widthPx?: number;
  heightPx?: number;
  rules?: RuleConfig;
  previewPng?: Uint8Array;
}
const jsonScript = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Local file:// page with classic JS and an embedded Blob worker; no server or remote resources. */
export async function writeStrokeEditor(directory: string, master: Master, options: StrokeEditorOptions = {}): Promise<string> {
  master = validateMaster(master);
  const profile = profileSchema.parse(options.profile ?? DEFAULT_PROFILE), rules = ruleSchema.parse(options.rules ?? DEFAULT_RULES);
  const size = resolveSize(master.bounds, profile, { mode: 'grid', widthPx: options.widthPx ?? Math.min(1200, Math.round(master.bounds.w)), heightPx: options.heightPx, linkAspect: true });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundles = await Promise.all([
    build({ entryPoints: [path.join(here, 'stroke-editor-client.ts')], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, minify: true }),
    build({ entryPoints: [path.join(here, 'stroke-editor-worker.ts')], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, minify: true }),
  ]);
  const configuration = { name: master.name, bounds: master.bounds, palette: master.palette, profile, widthPx: size.widthPx, heightPx: size.heightPx, rules };
  const preview = options.previewPng ? `data:image/png;base64,${Buffer.from(options.previewPng).toString('base64')}` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stroke inspector — ${escapeHtml(master.name)}</title><style>
  *{box-sizing:border-box}body{margin:0;color:#24392e;background:#f1f2ec;font:14px/1.5 system-ui,sans-serif}button,input{font:inherit}button{cursor:pointer;border:1px solid #ccd5c9;background:#fff;color:#24392e;border-radius:7px;padding:8px 12px}button:hover:not(:disabled){background:#edf4e8;border-color:#80967b}button:disabled{opacity:.4;cursor:default}button.primary{background:#284e39;color:white;border-color:#284e39}button:focus-visible,input:focus-visible,canvas:focus-visible{outline:3px solid #bd7825;outline-offset:2px}header{display:flex;gap:20px;align-items:center;justify-content:space-between;background:#fff;border-bottom:1px solid #dce1d6;padding:16px 24px}h1{margin:0;font:26px/1.15 Georgia,serif}header p{margin:5px 0 0;font-size:12px;color:#617461}.save-actions{display:flex;gap:8px;flex-wrap:wrap}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 24px;background:#fafbf7;border-bottom:1px solid #dce1d6}.divider{height:25px;width:1px;background:#d9ded3;margin:0 5px}.toolbar label{margin-left:8px;font-size:12px}.workbench{display:grid;grid-template-columns:minmax(0,1fr) 290px;min-height:480px;height:calc(100vh - 188px)}.stage{position:relative;overflow:hidden;background:#dfe4dc;min-height:480px}.stage canvas{width:100%;height:100%;display:block;touch-action:none;cursor:crosshair}.stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:.6}.stage .hint{position:absolute;left:15px;bottom:13px;background:#ffffffed;border:1px solid #d8e0d2;border-radius:6px;padding:6px 10px;font-size:11px;pointer-events:none;color:#566a56}aside{background:#fff;border-left:1px solid #d5dece;overflow:auto;padding:20px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin:0 0 12px;color:#71806a}.section{padding-bottom:22px;margin-bottom:22px;border-bottom:1px solid #e6eadf}.section:last-child{border:0}#selected-name{font-weight:600;overflow-wrap:anywhere}#selected-note{color:#6b7866;font-size:12px;margin:6px 0}.selection-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.swatches{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.swatch{font-size:11px;overflow:hidden;text-overflow:ellipsis}.swatch span{display:block;height:28px;border:1px solid #0002;border-radius:5px;margin-bottom:4px}.dimensions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.dimensions label{font-size:11px;color:#5c705b}.dimensions input{width:100%;border:1px solid #cfd8c8;border-radius:5px;padding:7px;color:#253b2e}#apply-size{margin-top:10px;width:100%}.secondary{font-size:11px;color:#7a8374;margin:8px 0 0}#hidden-list{display:grid;gap:5px;max-height:230px;overflow:auto;margin-top:10px}#hidden-list button{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;padding:6px 8px}#hidden-list button[aria-current=true]{border-color:#ba7422;background:#fff0d9}footer{display:flex;align-items:center;gap:16px;justify-content:space-between;padding:9px 24px;background:white;border-top:1px solid #d6dfce;font-size:12px}#status{color:#5e7056}#status[role=alert]{color:#a52c26}#change-note{color:#987037;text-align:right}#warnings{font-size:11px;margin-top:10px;color:#927139}#busy-dot{display:inline-block;width:7px;height:7px;background:#84917d;border-radius:50%;margin-right:7px}.loading #busy-dot,.busy #busy-dot{background:#ba782a;animation:pulse 1s infinite alternate}@keyframes pulse{to{opacity:.3}}@media(max-width:800px){header{align-items:start;flex-direction:column;padding:16px}.toolbar{padding:10px}.workbench{grid-template-columns:minmax(0,1fr) 235px}aside{padding:15px}h1{font-size:23px}.save-actions button{font-size:12px}}@media(max-width:580px){.workbench{height:auto;grid-template-columns:1fr}.stage{height:65vh;min-height:360px}aside{border-left:0}.toolbar label{margin:0}footer{padding:8px 12px}.divider{display:none}}
  button.primary:hover:not(:disabled){background:#365f45;border-color:#365f45}
  </style></head><body id="editor-root" class="loading" data-state="loading"><header><div><h1>Stroke inspector</h1><p>${escapeHtml(master.name)} · Select and hide individual strokes.</p></div><div class="save-actions"><button id="download-master" disabled>Download edited master</button><button id="download-bmp" class="primary" disabled>Download BMP</button></div></header>
  <div class="toolbar"><button id="undo" disabled title="Ctrl+Z">Undo</button><button id="redo" disabled title="Ctrl+Shift+Z">Redo</button><span class="divider"></span><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><button id="fit">Fit design</button><span id="zoom-label">100%</span><span class="divider"></span><label><input id="hidden-toggle" type="checkbox"> Show hidden strokes</label></div>
  <main class="workbench"><div class="stage" id="stage">${preview ? `<img id="loading-preview" src="${preview}" alt="Initial design preview">` : ''}<canvas id="stroke-canvas" tabindex="0" aria-label="Design canvas. Click a stroke to select it. Scroll to zoom; drag to pan."></canvas><div class="hint">Click a stroke · Scroll to zoom · Drag to pan</div></div><aside>
  <section class="section"><h2>Selected stroke</h2><div id="selected-name">No stroke selected</div><p id="selected-note">Zoom in, then click a line in the design.</p><div class="selection-actions"><button id="hide-stroke" disabled>Hide stroke</button><button id="restore-stroke" disabled>Restore stroke</button></div></section>
  <section class="section"><h2>Palette</h2><div class="swatches" id="swatches"></div></section>
  <section class="section"><h2>Output size</h2><div class="dimensions"><label>Width · hooks<input id="output-width" type="number" min="1" step="1" value="${size.widthPx}"></label><label>Height · picks<input id="output-height" type="number" min="1" step="1" value="${size.heightPx}"></label></div><button id="apply-size">Apply size</button><p id="physical-size" class="secondary"></p><p class="secondary">Sample profile: ${escapeHtml(profile.name)}. Verify loom settings before production.</p></section>
  <section class="section"><h2>Hidden strokes <span id="hidden-count">0</span></h2><p class="secondary">Select a hidden stroke here to find and restore it.</p><div id="hidden-list"></div></section><details id="warnings" hidden><summary>Preview notes</summary><ul id="warning-list"></ul></details></aside></main>
  <footer><span><i id="busy-dot"></i><span id="status" role="status">Preparing the design…</span></span><span id="change-note">Download your edited master to keep changes.</span></footer>
  <script id="editor-config" type="application/json">${jsonScript(configuration)}</script><script id="editor-master" type="application/json">${jsonScript(master)}</script><script id="editor-worker" type="application/json">${jsonScript(bundles[1].outputFiles[0].text)}</script><script src="stroke-editor.js"></script></body></html>`;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'stroke-editor.js'), bundles[0].outputFiles[0].text, 'utf8');
  const output = path.join(directory, 'stroke-editor.html');
  await writeFile(output, html, 'utf8');
  return output;
}
