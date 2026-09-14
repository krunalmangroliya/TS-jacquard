import type { MachineProfile, Palette, RuleConfig } from '../../core/src/types';
import { resolveSize } from '../../core/src/size';

const element = <T extends HTMLElement>(id: string): T => { const node = document.getElementById(id); if (!node) throw new Error(`Missing ${id}`); return node as T; };
const config = JSON.parse(element('editor-config').textContent!) as { name: string; bounds: { w: number; h: number }; palette: Palette; profile: MachineProfile; widthPx: number; heightPx: number; rules: RuleConfig };
const canvas = element<HTMLCanvasElement>('stroke-canvas'), context = canvas.getContext('2d')!, stage = element('stage');
const bitmap = document.createElement('canvas'), bitmapContext = bitmap.getContext('2d')!;
const status = element('status'), root = element('editor-root'), hiddenToggle = element<HTMLInputElement>('hidden-toggle');
const widthInput = element<HTMLInputElement>('output-width'), heightInput = element<HTMLInputElement>('output-height');
let ids: string[] = [], offsets = new Uint32Array(), points = new Float32Array(), locked: boolean[] = [];
let hidden = new Set<number>(), selection = -1, ready = false, busy = true, dirty = false, revision = 0, renderedRevision = -1, topologyBuilds = 0;
let widthPx = config.widthPx, heightPx = config.heightPx, previewWidth = widthPx, previewHeight = heightPx;
let zoom = 1, panX = 0, panY = 0, screenWidth = 1, screenHeight = 1, fitted = false;
const buckets = new Map<string, number[]>(), bucketSize = 48;
type Change = { edge: number; before: boolean; after: boolean };
const past: Change[] = [], future: Change[] = [];
const workerUrl = URL.createObjectURL(new Blob([JSON.parse(element('editor-worker').textContent!)], { type: 'text/javascript' }));
const worker = new Worker(workerUrl);
const stretch = config.profile.epi / config.profile.ppi;
const scales = (): [number, number] => [widthPx / config.bounds.w, heightPx * stretch / config.bounds.h];

function setStatus(message: string, error = false): void { status.textContent = message; status.setAttribute('role', error ? 'alert' : 'status'); }
function refreshButtons(): void {
  const selected = selection >= 0;
  element<HTMLButtonElement>('hide-stroke').disabled = !ready || !selected || hidden.has(selection) || locked[selection];
  element<HTMLButtonElement>('restore-stroke').disabled = !ready || !selected || !hidden.has(selection) || locked[selection];
  element<HTMLButtonElement>('undo').disabled = !past.length || !ready;
  element<HTMLButtonElement>('redo').disabled = !future.length || !ready;
  for (const id of ['download-master', 'download-bmp']) element<HTMLButtonElement>(id).disabled = !ready || busy || renderedRevision !== revision;
  element<HTMLButtonElement>('apply-size').disabled = !ready;
  root.className = !ready ? 'loading' : busy ? 'busy' : 'ready'; root.dataset.state = !ready ? 'loading' : busy ? 'busy' : 'ready';
  root.dataset.revision = String(revision); root.dataset.topologyBuilds = String(topologyBuilds);
  element('selected-name').textContent = selected ? `Stroke ${selection + 1}` : 'No stroke selected';
  element('selected-note').textContent = selected ? `${hidden.has(selection) ? 'Hidden' : 'Visible'}${locked[selection] ? ' · Locked' : ''} · ${ids[selection]}` : 'Zoom in, then click a line in the design.';
  element('change-note').textContent = dirty ? 'Changes are in this tab. Download your edited master to keep them.' : 'Download your edited master to keep changes.';
  element('physical-size').textContent = `${(widthPx / config.profile.epi).toFixed(2)} × ${(heightPx / config.profile.ppi).toFixed(2)} inches`;
}
function refreshHidden(): void {
  element('hidden-count').textContent = `(${hidden.size})`;
  const list = element('hidden-list'); list.replaceChildren();
  for (const index of [...hidden].sort((a, b) => a - b).slice(0, 150)) {
    const button = document.createElement('button'); button.textContent = `Stroke ${index + 1}`; button.dataset.edgeId = ids[index]; button.setAttribute('aria-current', String(index === selection));
    button.onclick = () => select(index, true); list.append(button);
  }
  if (hidden.size > 150) { const note = document.createElement('p'); note.className = 'secondary'; note.textContent = 'Showing the first 150. Turn on hidden strokes to select others on the canvas.'; list.append(note); }
  if (!hidden.size) { const note = document.createElement('p'); note.className = 'secondary'; note.textContent = 'No hidden strokes.'; list.append(note); }
}
function pathStroke(index: number, color: string, dashed = false): void {
  const [sx, sy] = scales(); context.beginPath();
  for (let i = offsets[index]; i < offsets[index + 1]; i += 2) {
    const x = panX + points[i] * sx * zoom, y = panY + points[i + 1] * sy * zoom;
    if (i === offsets[index]) context.moveTo(x, y); else context.lineTo(x, y);
  }
  context.strokeStyle = color; context.lineWidth = index === selection ? 3 : 1.5; context.setLineDash(dashed ? [5, 4] : []); context.stroke(); context.setLineDash([]);
}
let drawQueued = false;
function draw(): void {
  if (drawQueued) return; drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    const dpr = Math.min(devicePixelRatio || 1, 2); context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, screenWidth, screenHeight);
    context.fillStyle = '#fff'; context.fillRect(panX, panY, widthPx * zoom, heightPx * stretch * zoom);
    if (bitmap.width > 1) { context.imageSmoothingEnabled = false; context.drawImage(bitmap, 0, 0, previewWidth, previewHeight, panX, panY, widthPx * zoom, heightPx * stretch * zoom); }
    context.save(); context.beginPath(); context.rect(panX, panY, widthPx * zoom, heightPx * stretch * zoom); context.clip();
    if (hiddenToggle.checked) for (const index of hidden) if (index !== selection) pathStroke(index, '#d3508977', true);
    if (selection >= 0) pathStroke(selection, hidden.has(selection) ? '#c23c7c' : '#d87b08', hidden.has(selection));
    context.restore(); element('zoom-label').textContent = `${Math.round(zoom * 100)}%`;
  });
}
function fit(): void { zoom = Math.max(0.005, Math.min((screenWidth - 36) / widthPx, (screenHeight - 36) / (heightPx * stretch))); panX = (screenWidth - widthPx * zoom) / 2; panY = (screenHeight - heightPx * stretch * zoom) / 2; fitted = true; draw(); }
function resize(): void { screenWidth = stage.clientWidth; screenHeight = stage.clientHeight; const dpr = Math.min(devicePixelRatio || 1, 2); canvas.width = Math.round(screenWidth * dpr); canvas.height = Math.round(screenHeight * dpr); if (!fitted) fit(); else draw(); }
function zoomAt(factor: number, x = screenWidth / 2, y = screenHeight / 2): void { const next = Math.max(0.005, Math.min(160, zoom * factor)); panX = x - (x - panX) * next / zoom; panY = y - (y - panY) * next / zoom; zoom = next; draw(); }
function select(index: number, center = false): void {
  selection = index;
  if (center && index >= 0) {
    const [sx, sy] = scales(), first = offsets[index], last = offsets[index + 1] - 2;
    zoom = Math.max(zoom, 2); panX = screenWidth / 2 - (points[first] + points[last]) / 2 * sx * zoom; panY = screenHeight / 2 - (points[first + 1] + points[last + 1]) / 2 * sy * zoom;
  }
  refreshButtons(); refreshHidden(); draw();
}
function buildIndex(): void {
  buckets.clear();
  for (let edge = 0; edge < ids.length; edge++) {
    const touched = new Set<string>();
    for (let i = offsets[edge]; i + 3 < offsets[edge + 1]; i += 2) {
      const x0 = Math.floor(Math.min(points[i], points[i + 2]) / bucketSize), x1 = Math.floor(Math.max(points[i], points[i + 2]) / bucketSize);
      const y0 = Math.floor(Math.min(points[i + 1], points[i + 3]) / bucketSize), y1 = Math.floor(Math.max(points[i + 1], points[i + 3]) / bucketSize);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) touched.add(`${x},${y}`);
    }
    for (const key of touched) { const bucket = buckets.get(key) ?? []; bucket.push(edge); buckets.set(key, bucket); }
  }
}
function hit(x: number, y: number): number {
  const [sx, sy] = scales(), px = (x - panX) / (sx * zoom), py = (y - panY) / (sy * zoom), tx = 9 / (sx * zoom), ty = 9 / (sy * zoom);
  const candidates = new Set<number>();
  for (let row = Math.floor((py - ty) / bucketSize); row <= Math.floor((py + ty) / bucketSize); row++) for (let column = Math.floor((px - tx) / bucketSize); column <= Math.floor((px + tx) / bucketSize); column++) for (const edge of buckets.get(`${column},${row}`) ?? []) candidates.add(edge);
  let best = -1, distance = 81;
  for (const edge of candidates) {
    if (hidden.has(edge) && !hiddenToggle.checked && edge !== selection) continue;
    for (let i = offsets[edge]; i + 3 < offsets[edge + 1]; i += 2) {
      const ax = panX + points[i] * sx * zoom, ay = panY + points[i + 1] * sy * zoom, dx = (points[i + 2] - points[i]) * sx * zoom, dy = (points[i + 3] - points[i + 1]) * sy * zoom;
      const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
      const d = (x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2;
      if (d < distance || (d === distance && edge < best)) { best = edge; distance = d; }
    }
  }
  return best;
}
function apply(change: Change, redo: boolean): void {
  const value = redo ? change.after : change.before; if (value) hidden.add(change.edge); else hidden.delete(change.edge);
  revision++; dirty = true; busy = true; selection = change.edge; setStatus('Updating the preview…');
  worker.postMessage({ type: 'visibility', edgeId: ids[change.edge], hidden: value, revision }); refreshButtons(); refreshHidden(); draw();
}
function visibility(value: boolean): void {
  if (!ready || selection < 0 || locked[selection] || hidden.has(selection) === value) return;
  const change = { edge: selection, before: hidden.has(selection), after: value }; past.push(change); future.length = 0; apply(change, true);
}
function undo(): void { const change = past.pop(); if (change) { future.push(change); apply(change, false); } }
function redo(): void { const change = future.pop(); if (change) { past.push(change); apply(change, true); } }
function download(format: 'master' | 'bmp'): void { if (!busy && ready && renderedRevision === revision) { setStatus('Preparing your download…'); worker.postMessage({ type: 'download', format, revision }); } }
function saveBytes(bytes: ArrayBuffer, filename: string, type: string): void { const url = URL.createObjectURL(new Blob([bytes], { type })), link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }

worker.onmessage = ({ data }) => {
  if (data.type === 'progress') { setStatus(data.message); return; }
  if (data.type === 'strokes') {
    ids = data.ids; locked = data.locked; hidden = new Set<number>(data.hidden.flatMap((value: boolean, i: number) => value ? [i] : []));
    offsets = new Uint32Array(data.offsets); points = new Float32Array(data.points); buildIndex(); refreshHidden(); return;
  }
  if (data.type === 'preview') {
    if (data.revision !== revision) return;
    const values = new Uint8Array(data.grid), rgba = new Uint8ClampedArray(values.length * 4);
    for (let i = 0; i < values.length; i++) { const color = config.palette.entries[values[i]].exportRgb; rgba[i * 4] = color[0]; rgba[i * 4 + 1] = color[1]; rgba[i * 4 + 2] = color[2]; rgba[i * 4 + 3] = 255; }
    previewWidth = data.widthPx; previewHeight = data.heightPx; bitmap.width = previewWidth; bitmap.height = previewHeight; bitmapContext.putImageData(new ImageData(rgba, previewWidth, previewHeight), 0, 0);
    renderedRevision = data.revision; topologyBuilds = data.topologyBuilds; ready = true; busy = false;
    document.getElementById('loading-preview')?.remove(); setStatus(`${ids.length.toLocaleString('en')} strokes · ${widthPx} × ${heightPx} pixels`);
    const warningList = element('warning-list'); warningList.replaceChildren(); for (const message of data.warnings.slice(0, 30)) { const item = document.createElement('li'); item.textContent = message; warningList.append(item); } element('warnings').hidden = data.warnings.length === 0;
    refreshButtons(); draw(); return;
  }
  if (data.type === 'download') {
    const name = config.name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 90) || 'design';
    const filename = data.format === 'master' ? `${name}.edited-master.json` : `${name}_${data.widthPx}x${data.heightPx}.bmp`;
    saveBytes(data.buffer, filename, data.format === 'master' ? 'application/json' : 'image/bmp');
    if (data.format === 'master' && data.revision === revision) dirty = false;
    setStatus(`Downloaded ${filename}`); refreshButtons(); return;
  }
  if (data.type === 'error') { busy = false; setStatus(data.message, true); refreshButtons(); }
};
worker.onerror = event => { busy = false; setStatus(`Could not finish the preview: ${event.message}`, true); refreshButtons(); };
for (const entry of config.palette.entries.slice(0, 6)) { const swatch = document.createElement('div'); swatch.className = 'swatch'; const color = document.createElement('span'); color.style.backgroundColor = `rgb(${entry.exportRgb.join(',')})`; swatch.append(color, document.createTextNode(`${entry.index} · ${entry.name}`)); element('swatches').append(swatch); }
element('hide-stroke').onclick = () => visibility(true); element('restore-stroke').onclick = () => visibility(false);
element('undo').onclick = undo; element('redo').onclick = redo; element('download-master').onclick = () => download('master'); element('download-bmp').onclick = () => download('bmp');
element('fit').onclick = fit; element('zoom-in').onclick = () => zoomAt(1.4); element('zoom-out').onclick = () => zoomAt(1 / 1.4); hiddenToggle.onchange = draw;
element('apply-size').onclick = () => {
  const width = Number(widthInput.value), height = Number(heightInput.value);
  try { resolveSize(config.bounds, config.profile, { mode: 'grid', widthPx: width, heightPx: height, linkAspect: false }); }
  catch (error) { setStatus(error instanceof Error ? error.message : String(error), true); return; }
  if (width === widthPx && height === heightPx) return;
  widthPx = width; heightPx = height; revision++; busy = true; setStatus('Rendering the new size…'); worker.postMessage({ type: 'size', widthPx, heightPx, revision }); fit(); refreshButtons();
};
let pointer: { id: number; x: number; y: number; panX: number; panY: number; moved: boolean } | undefined;
canvas.onpointerdown = event => { if (event.button !== 0 && event.button !== 1) return; const rect = canvas.getBoundingClientRect(); pointer = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top, panX, panY, moved: false }; canvas.setPointerCapture(event.pointerId); };
canvas.onpointermove = event => { if (!pointer || event.pointerId !== pointer.id) return; const rect = canvas.getBoundingClientRect(), dx = event.clientX - rect.left - pointer.x, dy = event.clientY - rect.top - pointer.y; if (Math.hypot(dx, dy) > 4) pointer.moved = true; if (pointer.moved) { panX = pointer.panX + dx; panY = pointer.panY + dy; draw(); } };
canvas.onpointerup = event => { if (!pointer || pointer.id !== event.pointerId) return; if (!pointer.moved && ready) select(hit(pointer.x, pointer.y)); pointer = undefined; canvas.releasePointerCapture(event.pointerId); };
canvas.onpointercancel = () => { pointer = undefined; };
canvas.addEventListener('wheel', event => { event.preventDefault(); const rect = canvas.getBoundingClientRect(); zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
document.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); visibility(true); }
  if (event.key === 'Escape') select(-1);
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
new ResizeObserver(resize).observe(stage); resize(); refreshButtons(); refreshHidden();
// Read-only state and selection hooks make local file:// browser checks precise.
(window as unknown as { __strokeEditor: unknown }).__strokeEditor = {
  getState: () => ({ ready, busy, selection: ids[selection] ?? null, hiddenIds: [...hidden].map(i => ids[i]), revision, renderedRevision, topologyBuilds, widthPx, heightPx, undoCount: past.length, redoCount: future.length, edgeIds: [...ids] }),
  selectEdge: (id: string) => { const index = ids.indexOf(id); if (index < 0) throw new Error('Unknown stroke'); select(index, true); },
  screenPoint: (id: string) => { const index = ids.indexOf(id); if (index < 0) throw new Error('Unknown stroke'); const [sx, sy] = scales(), position = offsets[index], rect = canvas.getBoundingClientRect(); return { x: rect.left + panX + points[position] * sx * zoom, y: rect.top + panY + points[position + 1] * sy * zoom }; },
};
worker.postMessage({ type: 'init', masterJson: element('editor-master').textContent, profile: config.profile, rules: config.rules, widthPx, heightPx });
element('editor-master').remove(); element('editor-worker').remove();
