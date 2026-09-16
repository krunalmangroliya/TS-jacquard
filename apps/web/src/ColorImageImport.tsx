import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { DesignRecord } from '../../../packages/app-model/src';
import type { Master, Repeat, SourceInterpretation } from '../../../packages/core/src/types';
import { MAX_COLORS } from '../../../packages/core/src/types';
import { decodeRaster } from '../../../packages/core/src/raster';
import type { ColorImportJob, ColorImportResult } from './color-import.worker';
import { readImageFile, sourcePngBase64, type ImageDensityHint } from './image-input';
import { sourceAspectSettings } from './source-aspect';
import { Icon, Notice, request, rgbToHex, ScreenHeader, Spinner } from './ui';

interface Props { onCreated: (id: string) => void; onCancel: () => void; onCreating: (creating: boolean) => void }
interface Crop { x: number; y: number; w: number; h: number }
interface Source { file: File; url: string; width: number; height: number; densityHint?: ImageDensityHint }
interface Review extends ColorImportResult { crop: Crop; previewUrl: string; thumbnailPngBase64: string }

function makePreview(result: ColorImportResult) {
  const grid = decodeRaster(result.raster), canvas = document.createElement('canvas');
  const scale = Math.min(1, 1400 / result.raster.width, 1400 / result.raster.height);
  canvas.width = Math.max(1, Math.round(result.raster.width * scale)); canvas.height = Math.max(1, Math.round(result.raster.height * scale));
  const context = canvas.getContext('2d')!, pixels = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const index = grid[Math.min(result.raster.height - 1, Math.floor((y + .5) * result.raster.height / canvas.height)) * result.raster.width + Math.min(result.raster.width - 1, Math.floor((x + .5) * result.raster.width / canvas.width))];
    const rgb = result.palette.entries[index].displayRgb, offset = (y * canvas.width + x) * 4;
    pixels.data.set([...rgb, 255], offset);
  }
  context.putImageData(pixels, 0, 0);
  const previewUrl = canvas.toDataURL('image/png'), thumbnail = document.createElement('canvas');
  const thumbnailScale = Math.min(1, 320 / canvas.width, 320 / canvas.height);
  thumbnail.width = Math.max(1, Math.round(canvas.width * thumbnailScale)); thumbnail.height = Math.max(1, Math.round(canvas.height * thumbnailScale));
  thumbnail.getContext('2d')!.drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
  return { previewUrl, thumbnailPngBase64: thumbnail.toDataURL('image/png').split(',')[1] };
}

export default function ColorImageImport({ onCreated, onCancel, onCreating }: Props) {
  const [source, setSource] = useState<Source>(), [name, setName] = useState(''), [error, setError] = useState('');
  const [cropEnabled, setCropEnabled] = useState(false), [crop, setCrop] = useState<Crop>({ x: 0, y: 0, w: 8, h: 8 });
  const [colorMode, setColorMode] = useState<'preserve' | 'reduce'>('preserve'), [maxColors, setMaxColors] = useState('6'), [repeat, setRepeat] = useState<Repeat['type']>('none');
  const [sourceKind, setSourceKind] = useState<SourceInterpretation['kind']>('artwork'), [densityKnown, setDensityKnown] = useState(false), [sourceEpi, setSourceEpi] = useState(''), [sourcePpi, setSourcePpi] = useState('');
  const [review, setReview] = useState<Review>(), [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [creating, setCreating] = useState(false), [dragging, setDragging] = useState(false), [view, setView] = useState<'source' | 'colors'>('source');
  const input = useRef<HTMLInputElement>(null), worker = useRef<Worker | null>(null), generation = useRef(0), fileGeneration = useRef(0), sourceUrl = useRef(''), mounted = useRef(true);
  function cancelPreparation() { generation.current++; worker.current?.terminate(); worker.current = null; setBusy(false); }
  useEffect(() => { cancelPreparation(); setReview(undefined); setError(''); }, [source?.url, cropEnabled, crop.x, crop.y, crop.w, crop.h, colorMode, maxColors]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; fileGeneration.current++; worker.current?.terminate(); if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current); }; }, []);
  const rectangle = source && !cropEnabled ? { x: 0, y: 0, w: source.width, h: source.height } : crop;
  const cropValid = !!source && Object.values(rectangle).every(Number.isInteger) && rectangle.x >= 0 && rectangle.y >= 0 && rectangle.w >= 8 && rectangle.h >= 8 && rectangle.x + rectangle.w <= source.width && rectangle.y + rectangle.h <= source.height;
  const colorLimitValid = colorMode === 'preserve' || (Number.isInteger(Number(maxColors)) && Number(maxColors) >= 1 && Number(maxColors) <= MAX_COLORS);
  const sourceDensity = sourceKind === 'loom-grid' && densityKnown ? { epi: Number(sourceEpi), ppi: Number(sourcePpi) } : undefined;
  const sourceDensityValid = !sourceDensity || [sourceDensity.epi, sourceDensity.ppi, sourceDensity.epi / sourceDensity.ppi].every(value => Number.isFinite(value) && value > 0);
  async function selectFile(file?: File) {
    if (!file || creating) return;
    cancelPreparation(); const id = ++fileGeneration.current; setReview(undefined); setReading(true); setError('');
    try {
      const dimensions = await readImageFile(file); if (id !== fileGeneration.current) return;
      const url = URL.createObjectURL(file); if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current); sourceUrl.current = url;
      setSource({ file, url, ...dimensions }); setCrop({ x: 0, y: 0, w: dimensions.width, h: dimensions.height }); setCropEnabled(false); setName(file.name.replace(/\.(png|bmp|jpe?g)$/i, '')); setView('source');
      setSourceKind('artwork'); setDensityKnown(false); setSourceEpi(''); setSourcePpi('');
    } catch (error) { if (id === fileGeneration.current) setError((error as Error).message); }
    finally { if (id === fileGeneration.current) setReading(false); if (input.current) input.current.value = ''; }
  }
  async function prepare() {
    if (!source || !cropValid || !colorLimitValid) return;
    cancelPreparation(); const id = ++generation.current, selected = { ...rectangle }; setReview(undefined); setError(''); setBusy(true);
    try {
      const bitmap = await createImageBitmap(source.file); if (id !== generation.current) { bitmap.close(); return; }
      const canvas = document.createElement('canvas'); canvas.width = selected.w; canvas.height = selected.h;
      const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) { bitmap.close(); throw new Error('This browser could not prepare the image.'); }
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, selected.x, selected.y, selected.w, selected.h, 0, 0, selected.w, selected.h); bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height), current = new Worker(new URL('./color-import.worker.ts', import.meta.url), { type: 'module' }); worker.current = current;
      current.onmessage = event => {
        if (id !== generation.current || event.data.id !== id) return;
        current.terminate(); worker.current = null; setBusy(false);
        if (event.data.error) { setError(event.data.error); return; }
        try { const result = event.data.result as ColorImportResult; setReview({ ...result, crop: selected, ...makePreview(result) }); setView('colors'); }
        catch (error) { setError((error as Error).message); }
      };
      current.onerror = event => { if (id !== generation.current) return; cancelPreparation(); setError(event.message || 'Image preparation stopped. Try a smaller crop.'); };
      const job: ColorImportJob = { id, width: canvas.width, height: canvas.height, data: pixels.data.buffer as ArrayBuffer, colorLimit: colorMode === 'preserve' ? 'preserve' : Number(maxColors) };
      current.postMessage(job, [job.data]);
    } catch (error) { if (id === generation.current) { setBusy(false); setError((error as Error).message); } }
  }
  async function createMaster() {
    if (!source || !review || !sourceDensityValid) return;
    if (!name.trim()) { setError('Give this image a name before saving.'); return; }
    setCreating(true); onCreating(true); setError('');
    try {
      const now = new Date().toISOString(), id = crypto.randomUUID();
      const aspect = sourceAspectSettings(review.crop.w, review.crop.h, sourceKind, sourceDensity);
      const master: Master = {
        schemaVersion: 1, id, workspaceId: 'local', name: name.trim(), tags: [], createdAt: now, updatedAt: now,
        bounds: aspect.bounds, repeat: { type: repeat }, palette: review.palette, raster: review.raster,
        geometry: { nodes: {}, edges: {}, faceColors: {} }, objects: [],
        source: { fileId: `${id}-source`, widthPx: source.width, heightPx: source.height, interpretation: aspect.interpretation, ...(cropEnabled ? { crop: { ...review.crop } } : {}) },
        traceParams: { threshold: 'otsu', invert: false, minSpeckArea: 0, gapClosePx: 0, spurPrunePx: 0, simplifyTolerance: 1, fitMaxError: 1, cornerAngleDeg: 45 }, version: 1,
      };
      const png = await sourcePngBase64(source.file);
      if (!mounted.current) return;
      const saved = await request<DesignRecord>('/api/designs', { method: 'POST', body: JSON.stringify({ master, name: master.name, sourcePngBase64: png, thumbnailPngBase64: review.thumbnailPngBase64 }) });
      if (mounted.current) onCreated(saved.id);
    } catch (error) { if (mounted.current) setError((error as Error).message); } finally { if (mounted.current) { setCreating(false); onCreating(false); } }
  }
  function drop(event: DragEvent<HTMLElement>) { event.preventDefault(); setDragging(false); void selectFile(event.dataTransfer.files[0]); }
  return <main className="jdm-import jdm-screen">
    <ScreenHeader eyebrow="DIRECT COLOR IMAGE" title="Start with your filled design" description="Upload an image with its colors already filled. Then choose a size and clean up pixels." back={creating ? undefined : onCancel}>
      <button className="jdm-button" disabled={creating} onClick={onCancel}>Cancel</button>
      <button className="jdm-button jdm-button-primary" disabled={!review || !sourceDensityValid || busy || reading || creating} onClick={() => void createMaster()}>{creating ? <Spinner label="Creating master…" /> : <><Icon name="check" /> Create image master</>}</button>
    </ScreenHeader>
    {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
    <input type="file" accept="image/png,image/jpeg,image/bmp,.png,.jpg,.jpeg,.bmp" hidden ref={input} onChange={event => void selectFile(event.target.files?.[0])} />
    {!source ? <div className={`jdm-upload-zone ${dragging ? 'is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
      <div className="jdm-upload-icon"><Icon name="upload" size={38} /></div><div className="jdm-eyebrow">ALREADY COLORED, READY TO RESIZE</div>
      <h2>Drop your color image here</h2><p>BMP, PNG or JPG / JPEG.<br />Up to 8,192 pixels per side and 40 million pixels.</p>
      <button className="jdm-button jdm-button-primary" onClick={() => input.current?.click()} disabled={reading}>{reading ? <Spinner label="Reading image…" /> : 'Choose image file'}</button>
      <span className="jdm-fine">Keep all original colors, up to {MAX_COLORS}. Reducing or merging colors is your choice.</span>
    </div> : <div className="jdm-import-layout">
      <section className="jdm-import-preview">
        <div className="jdm-preview-toolbar"><div className="jdm-segmented"><button className={view === 'source' ? 'is-active' : ''} onClick={() => setView('source')}>Source</button><button className={view === 'colors' ? 'is-active' : ''} disabled={!review} onClick={() => setView('colors')}>Color preview</button></div><button className="jdm-link-button" disabled={reading || creating} onClick={() => input.current?.click()}>Change image</button></div>
        <div className="jdm-artboard" onDragOver={event => event.preventDefault()} onDrop={drop}>
          {cropValid ? view === 'colors' && review ? <img className="jdm-color-preview" src={review.previewUrl} alt="Imported color image preview" /> : <svg viewBox={`0 0 ${rectangle.w} ${rectangle.h}`} role="img" aria-label="Original color image with selected crop"><rect width={rectangle.w} height={rectangle.h} fill="white" /><image href={source.url} x={-rectangle.x} y={-rectangle.y} width={source.width} height={source.height} /></svg> : <p className="jdm-muted">Use whole numbers and keep the crop inside the image, at least 8 × 8 pixels.</p>}
          {busy && <div className="jdm-trace-progress"><Spinner label="Preparing image colors…" /><button className="jdm-link-button" onClick={cancelPreparation}>Cancel preparation</button></div>}
        </div>
        <div className="jdm-preview-caption"><span>{source.file.name}</span><span>{source.width.toLocaleString()} × {source.height.toLocaleString()} source px{cropEnabled ? ` · crop ${rectangle.w} × ${rectangle.h}` : ''}</span></div>
        {review && <Notice><strong>Color image ready.</strong> {review.quantized ? `${review.sourceColorCount.toLocaleString()} source colors reduced to ${review.palette.entries.length}. Compare the color preview with the source before saving.` : `All ${review.palette.entries.length} source colors are preserved.`} Create the image master, then choose your output size and pixel cleanup settings.</Notice>}
      </section>
      <aside className="jdm-import-controls"><fieldset className="jdm-color-fields" disabled={creating}>
        <div className="jdm-control-block"><label className="jdm-field">Master name<input className="jdm-input" value={name} onChange={event => setName(event.target.value)} maxLength={160} /></label><label className="jdm-field">Repeat layout<select className="jdm-select" value={repeat} onChange={event => setRepeat(event.target.value as Repeat['type'])}><option value="none">Panel / no repeat</option><option value="straight">Straight repeat tile</option></select></label><p className="jdm-fine">The whole image or selected crop is one panel or repeat tile. Repeats inside it are not detected automatically.</p></div>
        <div className="jdm-control-block"><h2>Source proportions</h2>
          <label className="jdm-field">Image interpretation<select className="jdm-select" value={sourceKind} onChange={event => setSourceKind(event.target.value as SourceInterpretation['kind'])}><option value="artwork">Ordinary artwork</option><option value="loom-grid">Prepared loom pixel grid</option></select></label>
          {sourceKind === 'artwork' ? <p className="jdm-fine">Use for drawings and regular images. Source pixels are treated as square; the output machine’s read and pick determine the export grid.</p> : <>
            <p className="jdm-fine">Use when this image is already a loom grid. Enter the source density to keep its physical proportions when choosing another machine or size.</p>
            <label className="jdm-check"><input type="checkbox" checked={densityKnown} onChange={event => setDensityKnown(event.target.checked)} /> I know the source read and pick</label>
            {densityKnown && <div className="jdm-crop-grid"><label className="jdm-field">Source read / EPI<input className="jdm-input" type="number" min="0.0001" step="any" value={sourceEpi} onChange={event => setSourceEpi(event.target.value)} /></label><label className="jdm-field">Source pick / PPI<input className="jdm-input" type="number" min="0.0001" step="any" value={sourcePpi} onChange={event => setSourcePpi(event.target.value)} /></label></div>}
            {source.densityHint && <div><p className="jdm-fine">File metadata suggests {Number(source.densityHint.epi.toFixed(4))} horizontal × {Number(source.densityHint.ppi.toFixed(4))} vertical pixels/inch. It may describe printer resolution; use it only if these are your source read and pick.</p><button className="jdm-link-button" onClick={() => { setSourceEpi(String(Number(source.densityHint!.epi.toFixed(4)))); setSourcePpi(String(Number(source.densityHint!.ppi.toFixed(4)))); setDensityKnown(true); }}>Use file density suggestion</button></div>}
            {!densityKnown ? <p className="jdm-fine">You can import now and keep explicit pixel dimensions. Linked proportions and Fit across stay unavailable until source density is supplied.</p> : !sourceDensityValid ? <p className="jdm-fine" role="alert">Enter positive source read and pick values, or turn off “I know the source read and pick” to use explicit pixel dimensions.</p> : <p className="jdm-fine">Selected {repeat === 'straight' ? 'repeat tile' : 'panel'}: {rectangle.w} × {rectangle.h} pixels · {(rectangle.w / sourceDensity!.epi).toFixed(3)} × {(rectangle.h / sourceDensity!.ppi).toFixed(3)} inches at source density.</p>}
            <p className="jdm-fine">Read is horizontal and pick is vertical in the preview’s current orientation. This choice does not rotate or resample the source.</p>
          </>}
        </div>
        <div className="jdm-control-block"><h2>Image colors</h2><label className="jdm-field">Color handling<select className="jdm-select" value={colorMode} onChange={event => setColorMode(event.target.value as 'preserve' | 'reduce')}><option value="preserve">Keep original colors</option><option value="reduce">Reduce colors</option></select></label>{colorMode === 'reduce' ? <><label className="jdm-field">Maximum colors<input className="jdm-input" type="number" min="1" max={MAX_COLORS} step="1" value={maxColors} onChange={event => setMaxColors(event.target.value)} /></label><p className="jdm-fine">Similar colors are combined automatically only if the image exceeds this limit. Review the result before saving.</p>{!colorLimitValid && <p className="jdm-fine" role="alert">Enter a whole number from 1 to {MAX_COLORS}.</p>}</> : <p className="jdm-fine">A 7-color image stays at 7 colors. Up to {MAX_COLORS} original colors are preserved; you can choose which colors to merge later in the editor.</p>}<p className="jdm-fine">Transparent areas use white. Photos and JPG shading may contain more than {MAX_COLORS} colors and need the Reduce colors option.</p></div>
        <div className="jdm-control-block"><label className="jdm-check"><input type="checkbox" checked={cropEnabled} onChange={event => setCropEnabled(event.target.checked)} /> Crop the source image</label>{cropEnabled && <div className="jdm-crop-grid">{(['x', 'y', 'w', 'h'] as const).map(key => <label className="jdm-field" key={key}>{({ x: 'Left', y: 'Top', w: 'Width', h: 'Height' })[key]}<input type="number" className="jdm-input" min={key === 'w' || key === 'h' ? 8 : 0} step="1" value={crop[key]} onChange={event => setCrop(previous => ({ ...previous, [key]: Number(event.target.value) }))} /></label>)}</div>}</div>
        <button className="jdm-button jdm-button-primary jdm-trace-button" disabled={reading || !cropValid || !colorLimitValid} onClick={() => void prepare()}>{busy ? 'Restart preparation' : review ? 'Prepare again' : 'Prepare color image'}</button>
        {review && <div className="jdm-import-palette"><span className="jdm-fine">Your image palette · {review.palette.entries.length} colors</span><div>{review.palette.entries.map(entry => <span key={entry.index} style={{ background: rgbToHex(entry.displayRgb) }} title={`${entry.index} · ${rgbToHex(entry.displayRgb)}`} />)}</div><p className="jdm-fine">You can edit or merge these colors in the editor.</p></div>}
        <p className="jdm-fine jdm-trace-help">Resizing keeps sharp color boundaries. Cleanup and pixel pencil corrections are saved separately for each size.</p>
      </fieldset></aside>
    </div>}
  </main>;
}
