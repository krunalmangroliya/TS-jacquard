import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import type { DesignRecord, WorkspaceSettings } from '../../../packages/app-model/src';
import type { Master, Repeat, TraceInputMode, TraceParams } from '../../../packages/core/src/types';
import { importPalette } from '../../../packages/core/src/input-preprocessing';
import type { ImportJob, ImportResult } from './import.worker';
import { Icon, Notice, request, rgbToHex, ScreenHeader, Spinner } from './ui';
import './library.css';
import ColorImageImport from './ColorImageImport';

interface Props { settings: WorkspaceSettings; onCreated: (id: string) => void; onCancel: () => void; initialMode?: 'sketch' | 'image' }
interface Crop { x: number; y: number; w: number; h: number }
interface Source { file: File; url: string; width: number; height: number }
interface Review extends ImportResult { crop: Crop; thumbnailPngBase64: string }
const presets: Record<string, { label: string; description: string; params: Partial<TraceParams> }> = {
  fine: { label: 'Keep fine detail', description: 'Retain small marks and closely follow the drawing.', params: { minSpeckArea: 4, simplifyTolerance: 0.6, fitMaxError: 0.9, spurPrunePx: 0 } },
  balanced: { label: 'Balanced', description: 'Smooth small irregularities while keeping the motif.', params: { minSpeckArea: 16, simplifyTolerance: 1, fitMaxError: 1.5, spurPrunePx: 0 } },
  smooth: { label: 'Smooth curves', description: 'Use fewer points on simple, clean drawings.', params: { minSpeckArea: 16, simplifyTolerance: 1.5, fitMaxError: 2.25, spurPrunePx: 0 } },
};
function blobBase64(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Could not read the selected image.')); reader.readAsDataURL(blob); }); }

export default function Import(props: Props) {
  const [mode, setMode] = useState<'sketch' | 'image'>(props.initialMode ?? 'sketch'), [creating, setCreating] = useState(false);
  return <><div className="jdm-import-modes" role="group" aria-label="Import workflow">
    <button aria-pressed={mode === 'sketch'} disabled={creating} onClick={() => setMode('sketch')}><strong>Sketch / line art</strong><span>Trace a drawing, then fill its regions.</span></button>
    <button aria-pressed={mode === 'image'} disabled={creating} onClick={() => setMode('image')}><strong>Direct color image</strong><span>Upload BMP, PNG or JPG with colors already filled.</span></button>
  </div>{mode === 'image' ? <ColorImageImport onCreated={props.onCreated} onCancel={props.onCancel} onCreating={setCreating} /> : <SketchImport {...props} onCreating={setCreating} />}</>;
}

function SketchImport({ settings, onCreated, onCancel, onCreating }: Props & { onCreating: (creating: boolean) => void }) {
  const previewClip = useId();
  const [source, setSource] = useState<Source | null>(null), [name, setName] = useState(''), [error, setError] = useState('');
  const [cropEnabled, setCropEnabled] = useState(false), [crop, setCrop] = useState<Crop>({ x: 0, y: 0, w: 8, h: 8 });
  const [automatic, setAutomatic] = useState(true), [threshold, setThreshold] = useState(157), [invert, setInvert] = useState(false), [preset, setPreset] = useState('balanced'), [repeat, setRepeat] = useState<Repeat['type']>('none'), [gap, setGap] = useState(0);
  const [inputMode, setInputMode] = useState<TraceInputMode>('black-white');
  const startingColors = importPalette(settings.defaultPalette, inputMode);
  const [review, setReview] = useState<Review | null>(null), [busy, setBusy] = useState(false), [stage, setStage] = useState(''), [creating, setCreating] = useState(false), [reading, setReading] = useState(false), [dragging, setDragging] = useState(false), [view, setView] = useState<'source' | 'trace'>('trace');
  const fileInput = useRef<HTMLInputElement>(null), workerRef = useRef<Worker | null>(null), generation = useRef(0), sourceUrl = useRef('');
  useEffect(() => { onCreating(creating); }, [creating, onCreating]);
  function cancelTrace() { generation.current++; workerRef.current?.terminate(); workerRef.current = null; setBusy(false); setStage(''); }
  useEffect(() => { cancelTrace(); setReview(null); }, [source?.url, cropEnabled, crop.x, crop.y, crop.w, crop.h, automatic, threshold, invert, preset, repeat, gap, inputMode]);
  useEffect(() => () => { generation.current++; workerRef.current?.terminate(); if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current); }, []);
  async function selectFile(file?: File) {
    if (!file) return; cancelTrace(); const id = ++generation.current; setReview(null); setReading(true); setError('');
    try {
      const header = new Uint8Array(await file.slice(0, 33).arrayBuffer());
      if (header.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => header[i] === byte) || String.fromCharCode(...header.slice(12, 16)) !== 'IHDR') throw new Error('Choose a PNG image. JPG, SVG, and renamed image files are not supported here.');
      const data = new DataView(header.buffer), width = data.getUint32(16), height = data.getUint32(20);
      if (width < 8 || height < 8 || width > 8192 || height > 8192 || width * height > 40_000_000) throw new Error('Use a PNG between 8 and 8,192 pixels on each side, with no more than 40 million pixels.');
      if (id !== generation.current) return;
      const url = URL.createObjectURL(file); if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current); sourceUrl.current = url;
      setSource({ file, url, width, height }); setCrop({ x: 0, y: 0, w: width, h: height }); setCropEnabled(false); setName(file.name.replace(/\.png$/i, '')); setView('source');
    } catch (error) { if (id === generation.current) setError((error as Error).message); }
    finally { if (id === generation.current) setReading(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  const selectedCrop = source ? cropEnabled ? crop : { x: 0, y: 0, w: source.width, h: source.height } : crop;
  function validateCrop(rectangle: Crop, image: Source) {
    if (![rectangle.x, rectangle.y, rectangle.w, rectangle.h].every(Number.isInteger) || rectangle.x < 0 || rectangle.y < 0 || rectangle.w < 8 || rectangle.h < 8 || rectangle.x + rectangle.w > image.width || rectangle.y + rectangle.h > image.height) throw new Error('The crop must stay inside the image and be at least 8 × 8 source pixels. Use whole numbers.');
  }
  async function startTrace() {
    if (!source) return; cancelTrace(); const id = ++generation.current; setError(''); setReview(null); setBusy(true); setStage('Preparing image pixels…');
    const rectangle = { ...selectedCrop };
    try {
      validateCrop(rectangle, source);
      if (!Number.isFinite(gap) || gap < 0 || gap > 20) throw new Error('Gap repair must be between 0 and 20 source pixels.');
      const bitmap = await createImageBitmap(source.file);
      if (id !== generation.current) { bitmap.close(); return; }
      const canvas = document.createElement('canvas'); canvas.width = rectangle.w; canvas.height = rectangle.h;
      const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) { bitmap.close(); throw new Error('This browser could not prepare the image.'); }
      context.fillStyle = inputMode === 'black-gold' ? '#000000' : '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, rectangle.x, rectangle.y, rectangle.w, rectangle.h, 0, 0, rectangle.w, rectangle.h); bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const thumbnail = document.createElement('canvas'), scale = Math.min(1, 320 / canvas.width, 320 / canvas.height);
      thumbnail.width = Math.max(1, Math.round(canvas.width * scale)); thumbnail.height = Math.max(1, Math.round(canvas.height * scale)); thumbnail.getContext('2d')!.drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
      const thumbnailPngBase64 = thumbnail.toDataURL('image/png').split(',')[1];
      const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' }); workerRef.current = worker;
      worker.onmessage = event => {
        if (id !== generation.current || event.data.id !== id) return;
        if (event.data.stage) { setStage(event.data.stage); return; }
        worker.terminate(); workerRef.current = null; setBusy(false); setStage('');
        if (event.data.error) { setError(event.data.error); return; }
        setReview({ ...event.data.result, crop: rectangle, thumbnailPngBase64 }); setView('trace');
      };
      worker.onerror = event => { if (id !== generation.current) return; worker.terminate(); workerRef.current = null; setBusy(false); setStage(''); setError(event.message || 'Tracing stopped unexpectedly. Try again with a smaller crop.'); };
      const job: ImportJob = { id, width: rectangle.w, height: rectangle.h, data: pixels.data.buffer as ArrayBuffer, params: { ...presets[preset].params, inputMode, threshold: automatic ? 'otsu' : threshold, invert, gapClosePx: gap }, repeat: { type: repeat }, strokeColorIndex: startingColors.strokeColorIndex };
      worker.postMessage(job, [job.data]);
    } catch (error) { if (id === generation.current) { setError((error as Error).message); setBusy(false); setStage(''); } }
  }
  async function createMaster() {
    if (!review || !source) return; setError('');
    if (!name.trim()) { setError('Give this master a name before saving.'); return; }
    setCreating(true);
    try {
      const now = new Date().toISOString(), id = crypto.randomUUID();
      const master: Master = { schemaVersion: 1, id, workspaceId: 'local', name: name.trim(), tags: [], createdAt: now, updatedAt: now, bounds: { w: review.crop.w, h: review.crop.h }, repeat: { type: repeat }, palette: startingColors.palette, geometry: review.trace.geometry, objects: review.trace.objects, source: { fileId: `${id}-source`, widthPx: source.width, heightPx: source.height, ...(cropEnabled ? { crop: { ...review.crop } } : {}) }, traceParams: review.trace.params, version: 1 };
      const sourcePngBase64 = await blobBase64(source.file);
      const saved = await request<DesignRecord>('/api/designs', { method: 'POST', body: JSON.stringify({ master, name: name.trim(), sourcePngBase64, thumbnailPngBase64: review.thumbnailPngBase64 }) }); onCreated(saved.id);
    } catch (error) { setError((error as Error).message); } finally { setCreating(false); }
  }
  function drop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setDragging(false); if (!creating) void selectFile(event.dataTransfer.files[0]); }
  function cropChange(key: keyof Crop, event: ChangeEvent<HTMLInputElement>) { setCrop(value => ({ ...value, [key]: Number(event.target.value) })); }
  const cropValid = source && selectedCrop.w >= 8 && selectedCrop.h >= 8 && selectedCrop.x >= 0 && selectedCrop.y >= 0 && selectedCrop.x + selectedCrop.w <= source.width && selectedCrop.y + selectedCrop.h <= source.height;
  return <main className="jdm-import jdm-screen">
    <ScreenHeader eyebrow="NEW VECTOR MASTER" title="Begin with your drawing" description="Import black-and-white or black-and-gold artwork. Review the trace before coloring." back={creating ? undefined : onCancel}><button className="jdm-button" onClick={onCancel} disabled={creating}>Cancel</button><button className="jdm-button jdm-button-primary" disabled={!review || busy || creating || reading} onClick={() => void createMaster()}>{creating ? <Spinner label="Creating master…" /> : <><Icon name="check" /> Create master</>}</button></ScreenHeader>
    {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
    <input type="file" accept="image/png,.png" ref={fileInput} hidden onChange={event => void selectFile(event.target.files?.[0])} />
    {!source ? <div className={`jdm-upload-zone ${dragging ? 'is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}><div className="jdm-upload-icon"><Icon name="upload" size={38} /></div><div className="jdm-eyebrow">YOUR ORIGINAL, READY FOR A NEW LIFE</div><h2>Drop your artwork PNG here</h2><p>Choose Black &amp; White or Black &amp; Gold after uploading.<br />A panel or one repeat tile, up to 8,192 pixels per side.</p><button className="jdm-button jdm-button-primary" onClick={() => fileInput.current?.click()} disabled={reading}>{reading ? <Spinner label="Reading image…" /> : 'Choose PNG file'}</button><span className="jdm-fine">The original image is kept with your master.</span></div> : <div className="jdm-import-layout">
      <section className="jdm-import-preview"><div className="jdm-preview-toolbar"><div className="jdm-segmented"><button className={view === 'source' ? 'is-active' : ''} onClick={() => setView('source')}>Source</button><button className={view === 'trace' ? 'is-active' : ''} disabled={!review} onClick={() => setView('trace')}>Trace overlay</button></div><button className="jdm-link-button" onClick={() => fileInput.current?.click()} disabled={creating || reading}>Change image</button></div><div className="jdm-artboard" onDragOver={event => event.preventDefault()} onDrop={drop}>{cropValid ? <svg viewBox={`0 0 ${selectedCrop.w} ${selectedCrop.h}`} role="img" aria-label={view === 'trace' && review ? 'Traced curves over the original drawing' : 'Original drawing with selected crop'}><defs><clipPath id={previewClip}><rect width={selectedCrop.w} height={selectedCrop.h} /></clipPath></defs><g clipPath={`url(#${previewClip})`}><rect width={selectedCrop.w} height={selectedCrop.h} fill={inputMode === 'black-gold' ? '#000000' : 'white'} /><image href={source.url} x={-selectedCrop.x} y={-selectedCrop.y} width={source.width} height={source.height} />{view === 'trace' && review && <path d={review.path} fill="none" stroke="#168d9a" strokeWidth="1.25" vectorEffect="non-scaling-stroke" opacity="0.88" />}</g></svg> : <p className="jdm-muted">Adjust the crop to fit inside your image.</p>}{busy && <div className="jdm-trace-progress"><Spinner label={stage} /><button className="jdm-link-button" onClick={cancelTrace}>Cancel trace</button></div>}</div><div className="jdm-preview-caption"><span>{source.file.name}</span><span>{source.width.toLocaleString()} × {source.height.toLocaleString()} source px{cropEnabled ? ` · crop ${selectedCrop.w} × ${selectedCrop.h}` : ''}</span></div>
        {review && <><div className="jdm-trace-stats">{[[review.trace.report.nodes, 'nodes'], [review.trace.report.faces, 'regions'], [review.trace.report.objects, 'objects'], [review.trace.report.openEnds.length, 'open ends']].map(([value, label]) => <div key={label}><strong>{Number(value).toLocaleString()}</strong><span>{label}</span></div>)}</div><Notice><strong>Ready for your review.</strong> {inputMode === 'black-gold' ? 'Gold shapes and fine dark cuts are preserved as editable fills. Edit fill colors or boundary nodes in the editor; add an outline if needed. Hiding an outline keeps the fill.' : 'Enclosed regions are unassigned. Choose colors after creating the master. Open ends can include intentional detail strokes.'}</Notice><details className="jdm-import-notes"><summary>Trace notes · {review.warnings.length}</summary><ul>{review.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details></>}
      </section>
      <aside className="jdm-import-controls"><div className="jdm-control-block"><label className="jdm-field">Which colors are in your image?<select className="jdm-select" aria-label="Image colors" value={inputMode} onChange={event => { setInputMode(event.target.value as TraceInputMode); setInvert(false); setAutomatic(true); }}><option value="black-white">Black &amp; White</option><option value="black-gold">Black &amp; Gold</option></select></label><p className="jdm-fine">{inputMode === 'black-gold' ? 'Gold artwork on a dark background. Gold becomes the visible drawing.' : 'Dark lines on a light background.'}</p></div><div className="jdm-control-block"><label className="jdm-field">Master name<input className="jdm-input" value={name} onChange={event => setName(event.target.value)} maxLength={160} /></label><label className="jdm-field">Artwork type<select className="jdm-select" aria-label="Artwork type" value={repeat} onChange={event => setRepeat(event.target.value as Repeat['type'])}><option value="none">Panel / no repeat</option><option value="straight">Straight repeat tile</option></select></label><p className="jdm-fine">{repeat === 'none' ? 'Opposite edges stay separate.' : 'Choose this only when opposite edges are designed to join.'}</p></div>
        <div className="jdm-control-block"><div className="jdm-control-heading"><h2>Trace settings</h2>{review && <span className="jdm-pill">Threshold {review.trace.report.threshold}</span>}</div><label className="jdm-check"><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)} /> Find threshold automatically</label><label className={`jdm-field ${automatic ? 'jdm-muted' : ''}`}>{inputMode === 'black-gold' ? 'Gold / black separation' : 'Black / white threshold'}<div className="jdm-range-row"><input type="range" min="0" max="255" value={threshold} disabled={automatic} onChange={event => setThreshold(Number(event.target.value))} aria-label="Black and white threshold" /><input type="number" className="jdm-input" min="0" max="255" value={threshold} disabled={automatic} onChange={event => setThreshold(Math.max(0, Math.min(255, Number(event.target.value))))} aria-label="Threshold value" /></div></label><label className="jdm-check"><input type="checkbox" checked={invert} onChange={event => setInvert(event.target.checked)} /> Invert light and dark</label><label className="jdm-field">Detail preset<select className="jdm-select" aria-label="Detail preset" value={preset} onChange={event => setPreset(event.target.value)}>{Object.entries(presets).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label><p className="jdm-fine">{presets[preset].description}</p><details className="jdm-advanced"><summary>Gap repair</summary><label className="jdm-field">Maximum gap in source pixels<input type="number" className="jdm-input" min="0" max="20" step="0.5" disabled={inputMode === 'black-gold'} value={gap} onChange={event => setGap(Number(event.target.value))} /></label><p className="jdm-fine">{inputMode === 'black-gold' ? 'Gold shapes keep their source boundaries. Gap repair applies to black-and-white line art.' : '0 keeps open ends as drawn. Inspect any automatic joins before coloring.'}</p></details></div>
        <div className="jdm-control-block"><label className="jdm-check"><input type="checkbox" checked={cropEnabled} onChange={event => setCropEnabled(event.target.checked)} /> Crop the source image</label>{cropEnabled && <><div className="jdm-crop-grid">{(['x', 'y', 'w', 'h'] as const).map(key => <label className="jdm-field" key={key}>{({ x: 'Left', y: 'Top', w: 'Width', h: 'Height' })[key]}<input type="number" className="jdm-input" min={key === 'w' || key === 'h' ? 8 : 0} step="1" value={crop[key]} onChange={event => cropChange(key, event)} /></label>)}</div><p className="jdm-fine">Coordinates are source pixels. The original image remains saved.</p></>}</div>
        <button className="jdm-button jdm-button-primary jdm-trace-button" disabled={creating || reading || !cropValid} onClick={() => void startTrace()}>{busy ? <><Icon name="upload" size={17} /> Restart trace</> : <><Icon name="leaf" size={18} /> {review ? 'Trace again' : 'Trace image'}</>}</button><p className="jdm-fine jdm-trace-help">Settings stay available while tracing. Changing them cancels the current trace.</p><div className="jdm-import-palette"><span className="jdm-fine">Your starting palette</span><div>{startingColors.palette.entries.map(entry => <span key={entry.index} style={{ background: rgbToHex(entry.displayRgb) }} title={`${entry.index} · ${entry.name}`} />)}</div><p className="jdm-fine">{inputMode === 'black-gold' ? 'Gold shapes use one gold fill on a dark ground. Boundaries have no added outline; their nodes remain editable.' : 'Visible strokes scale with the source. No fill colors are assigned automatically.'}</p></div>
      </aside>
    </div>}
  </main>;
}
