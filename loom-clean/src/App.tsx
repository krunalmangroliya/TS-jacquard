import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CanvasEditor, { type CompareMode, type EditorTool } from './CanvasEditor';
import AiReview, { type AiView } from './AiReview';
import { analyzeWithAi } from './ai-client';
import type { AiResult } from './ai-types';
import RegionReview from './RegionReview';
import { analyzeRegions } from './region-client';
import { applyTextureRegions } from './region-proposals';
import type { RegionScanResult, RegionView } from './region-types';
import { replaceColor } from './editor';
import { downloadBlob, encodeBmp, hexRgb, readImageFile, rgbHex, savePng } from './io';
import { processImage } from './processor';
import { MAX_SOURCE_PIXELS, MAX_OUTPUT_PIXELS, MAX_SIDE, type CleanupOptions, type CleanupResult, type IndexedImage, type Progress, type SourceImage } from './types';
import { parseReadPick, rotateSource, suggestOutlineColor, type SampleCatalog, type SamplePreset, type SourceOrientation } from './sample-presets';

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    upload: <><path d="M12 16V3m-4 4 4-4 4 4M4 15v5h16v-5" /></>,
    arrow: <path d="M4 12h15m-5-5 5 5-5 5" />,
    fill: <><path d="m4 11 8-8 9 9-8 8-9-9Zm0 0h17M6 3l7 9" /><path d="M3 17s-2 2-2 3a2 2 0 0 0 4 0c0-1-2-3-2-3Z" /></>,
    pencil: <><path d="m4 16 12-12 4 4L8 20H4v-4ZM13 7l4 4" /></>,
    pick: <><path d="m13 4 7 7m-2-9 4 4-6 6-4-4 6-6ZM12 9l-9 9v3h3l9-9" /></>,
    pan: <><path d="M8 12V5a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9c0 5-3 7-7 7-3 0-4-1-6-4l-4-5a2 2 0 0 1 3-2l2 2" /></>,
    undo: <path d="M9 5 3 10l6 5M3 10h11a6 6 0 0 1 6 6v3" />,
    redo: <path d="m15 5 6 5-6 5m6-5H10a6 6 0 0 0-6 6v3" />,
    download: <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" />,
    sparkle: <><path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3ZM20 2v4m-2-2h4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    file: <><path d="M6 2h8l5 5v15H6V2Zm8 0v6h5" /><path d="M9 13h7m-7 4h7" /></>,
    reset: <><path d="M4 9a8 8 0 1 1 0 7M4 3v6h6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.sparkle}</svg>;
}
function Thumbnail({ image }: { image: IndexedImage }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!; canvas.width = 60; canvas.height = 76;
    const context = canvas.getContext('2d')!;
    const data = context.createImageData(60, 76);
    for (let y = 0; y < 76; y++) for (let x = 0; x < 60; x++) {
      const color = image.palette[image.pixels[Math.floor(y / 76 * image.height) * image.width + Math.floor(x / 60 * image.width)]];
      const at = (y * 60 + x) * 4;
      data.data.set([...color, 255], at);
    }
    context.putImageData(data, 0, 0);
  }, [image]);
  return <canvas className="source-thumbnail" ref={ref} />;
}
const shortNumber = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const optionsEqual = (a: CleanupOptions, b: CleanupOptions) => JSON.stringify(a) === JSON.stringify(b);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function App() {
  const [source, setSource] = useState<SourceImage | null>(null);
  const [sourceOrientation, setSourceOrientation] = useState<SourceOrientation>(0);
  const [resultOrientation, setResultOrientation] = useState<SourceOrientation | null>(null);
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [resultOptions, setResultOptions] = useState<CleanupOptions | null>(null);
  const [history, setHistory] = useState<{ images: IndexedImage[]; index: number }>({ images: [], index: -1 });
  const [read, setRead] = useState(96), [pick, setPick] = useState(52);
  const [sizeMode, setSizeMode] = useState<'physical' | 'pixels'>('physical');
  const [unit, setUnit] = useState<'in' | 'cm'>('in');
  const [physicalWidth, setPhysicalWidth] = useState(8), [physicalHeight, setPhysicalHeight] = useState(19);
  const [pixelWidth, setPixelWidth] = useState(768), [pixelHeight, setPixelHeight] = useState(988);
  const [strength, setStrength] = useState<CleanupOptions['strength']>('balanced');
  const [flattenTexture, setFlattenTexture] = useState(true);
  const [outlineColor, setOutlineColor] = useState<number | null>(null);
  const [protectedColors, setProtectedColors] = useState<number[]>([]);
  const [repeatX, setRepeatX] = useState(false), [repeatY, setRepeatY] = useState(false);
  const [maxColors, setMaxColors] = useState(0);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sampleCatalog, setSampleCatalog] = useState<SampleCatalog>({ samples: [], warnings: [] });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [importHint, setImportHint] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [aiProgress, setAiProgress] = useState<Progress | null>(null);
  const [aiPreview, setAiPreview] = useState<AiResult | null>(null);
  const [aiBaseline, setAiBaseline] = useState<IndexedImage | null>(null);
  const [aiView, setAiView] = useState<AiView>('proposal');
  const [aiError, setAiError] = useState('');
  const [regionProgress, setRegionProgress] = useState<Progress | null>(null);
  const [regions, setRegions] = useState<RegionScanResult | null>(null);
  const [regionBaseline, setRegionBaseline] = useState<IndexedImage | null>(null);
  const [selectedRegions, setSelectedRegions] = useState<number[]>([]);
  const [regionView, setRegionView] = useState<RegionView>('proposal');
  const [regionError, setRegionError] = useState('');
  const [focusRegion, setFocusRegion] = useState<{ x: number; y: number; width: number; height: number; token: number }>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<CompareMode>('cleaned');
  const [tool, setTool] = useState<EditorTool>('pan');
  const [selectedColor, setSelectedColor] = useState(0);
  const [replaceFrom, setReplaceFrom] = useState(0);
  const [newColor, setNewColor] = useState('#b9d878');
  const [physicalPreview, setPhysicalPreview] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string } | null>(null);
  const confirmResolve = useRef<((accepted: boolean) => void) | null>(null);
  const keepEditingButton = useRef<HTMLButtonElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const job = useRef<{ cancel: () => void } | null>(null);
  const aiJob = useRef<{ cancel: () => void } | null>(null);
  const aiTaskId = useRef(0);
  const regionJob = useRef<{ cancel: () => void } | null>(null);
  const regionTaskId = useRef(0);
  const focusToken = useRef(0);
  const taskId = useRef(0);
  const dragDepth = useRef(0);
  const processingBusy = loading || progress !== null || confirmation !== null;
  const aiReviewActive = aiProgress !== null || aiPreview !== null;
  const regionReviewActive = regionProgress !== null || regions !== null;
  const reviewActive = aiReviewActive || regionReviewActive;
  const busy = processingBusy || reviewActive;
  const askConfirmation = useCallback((title: string, description: string): Promise<boolean> => new Promise(resolve => {
    if (confirmResolve.current) { resolve(false); return; }
    confirmResolve.current = resolve;
    setConfirmation({ title, description });
  }), []);
  const answerConfirmation = useCallback((accepted: boolean) => {
    const resolve = confirmResolve.current;
    confirmResolve.current = null;
    setConfirmation(null);
    resolve?.(accepted);
  }, []);
  const refreshSamples = useCallback(async () => {
    setCatalogLoading(true); setCatalogError('');
    try {
      const response = await fetch('/__loom_samples', { cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Local samples are available when you open the app with the Loom Clean launcher.');
      const catalog = await response.json() as SampleCatalog;
      if (!Array.isArray(catalog.samples) || !Array.isArray(catalog.warnings)) throw new Error('Sample library could not be read.');
      setSampleCatalog(catalog);
    } catch (reason) { setCatalogError(message(reason)); }
    finally { setCatalogLoading(false); }
  }, []);
  useEffect(() => { void refreshSamples(); }, [refreshSamples]);
  useEffect(() => {
    if (!confirmation) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    keepEditingButton.current?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [confirmation]);
  const width = sizeMode === 'pixels' ? Math.round(pixelWidth) : Math.round(physicalWidth / (unit === 'cm' ? 2.54 : 1) * read);
  const height = sizeMode === 'pixels' ? Math.round(pixelHeight) : Math.round(physicalHeight / (unit === 'cm' ? 2.54 : 1) * pick);
  const sizeValid = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_OUTPUT_PIXELS && read > 0 && pick > 0 && read <= 5000 && pick <= 5000;
  const options: CleanupOptions = { width, height, read, pick, strength, flattenTexture, outlineColor, protectedColors, repeatX, repeatY };
  const edited = history.images[history.index] || null;
  const orientedSource = useMemo(() => source ? rotateSource(source, sourceOrientation) : null, [source, sourceOrientation]);
  const regionalImage = useMemo(() => regionBaseline && regions ? applyTextureRegions(regionBaseline, regions.proposals.filter(p => selectedRegions.includes(p.id))) : null, [regionBaseline, regions, selectedRegions]);
  const regionHighlights = useMemo(() => regions?.proposals.map(p => ({ id: p.id, ...p.bounds, selected: selectedRegions.includes(p.id) })), [regions, selectedRegions]);
  const displayedImage = regions ? regionView === 'before' ? regionBaseline : regionalImage : aiPreview ? aiView === 'before' ? aiBaseline : aiPreview.image : edited || orientedSource;
  const dirtySettings = !!resultOptions && (!optionsEqual(options, resultOptions) || resultOrientation !== sourceOrientation);
  const baseName = source?.name.replace(/\.[^.]+$/, '') || 'design';
  const outputName = `${baseName}-clean-r${resultOptions?.read || read}p${resultOptions?.pick || pick}`;
  const baseline = useMemo(() => result ? { ...result.image, pixels: result.baseline } : undefined, [result]);
  const aiChangeKinds = useMemo(() => aiPreview?.changes.map(kind => kind === 2 ? 3 : kind), [aiPreview]);
  const canvasMode: CompareMode = regions ? regionView === 'changes' ? 'changes' : 'cleaned' : aiPreview ? aiView === 'changes' ? 'changes' : 'cleaned' : result ? mode : 'cleaned';
  const commit = useCallback((next: IndexedImage) => {
    setHistory(current => {
      if (current.images[current.index] === next) return current;
      const images = [...current.images.slice(0, current.index + 1), next].slice(-16);
      return { images, index: images.length - 1 };
    });
    setNotice('');
  }, []);
  const undo = useCallback(() => setHistory(h => ({ ...h, index: Math.max(0, h.index - 1) })), []);
  const redo = useCallback(() => setHistory(h => ({ ...h, index: Math.min(h.images.length - 1, h.index + 1) })), []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable]') || busy) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const shortcuts: Record<string, EditorTool> = { h: 'pan', f: 'fill', b: 'pencil', i: 'pick' };
      if (shortcuts[event.key.toLowerCase()]) setTool(shortcuts[event.key.toLowerCase()]);
      if (result && ['1', '2', '3'].includes(event.key)) setMode(event.key === '1' ? 'original' : event.key === '2' ? 'cleaned' : 'changes');
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [undo, redo, busy, result]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (result) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [result]);
  useEffect(() => () => { job.current?.cancel(); taskId.current++; aiJob.current?.cancel(); aiTaskId.current++; regionJob.current?.cancel(); regionTaskId.current++; confirmResolve.current?.(false); confirmResolve.current = null; }, []);
  const clearOutput = () => {
    aiTaskId.current++; aiJob.current?.cancel(); aiJob.current = null;
    setAiProgress(null); setAiPreview(null); setAiBaseline(null); setAiError('');
    regionTaskId.current++; regionJob.current?.cancel(); regionJob.current = null;
    setRegionProgress(null); setRegions(null); setRegionBaseline(null); setSelectedRegions([]); setRegionError(''); setFocusRegion(undefined);
    setResult(null); setResultOptions(null); setResultOrientation(null); setHistory({ images: [], index: -1 }); setMode('cleaned'); setTool('pan'); setNotice(''); setPhysicalPreview(false);
  };
  const importFile = async (file: File, allowReset = false, preset?: SamplePreset) => {
    if (busy) return;
    if (result && !allowReset && !await askConfirmation('Replace this artwork?', 'Download your BMP or PNG first to keep the current result and canvas edits. Continuing will replace them with the new artwork.')) return;
    const id = ++taskId.current;
    setPendingFile(file); setLoading(true); setError(''); setNotice('');
    try {
      const next = await readImageFile(file, maxColors || undefined);
      if (id !== taskId.current) return;
      setSource(next); setSourceOrientation(0); setActiveSampleId(preset?.id || null); clearOutput(); setProtectedColors([]); setSelectedColor(0); setReplaceFrom(0);
      const filenameSettings = parseReadPick(file.name);
      if (preset) {
        setRead(preset.read); setPick(preset.pick); setPixelWidth(preset.width); setPixelHeight(preset.height); setSizeMode('pixels');
        const hint = `Paired sample: R${preset.read} / P${preset.pick}, ${preset.width.toLocaleString()} × ${preset.height.toLocaleString()} px from its sized BMP. Processing starts from the PNG.`;
        setImportHint(hint); setNotice(hint);
      } else {
        setPixelWidth(next.width); setPixelHeight(next.height);
        if (filenameSettings) {
          setRead(filenameSettings.read); setPick(filenameSettings.pick);
          const hint = `Filename detected R${filenameSettings.read} / P${filenameSettings.pick}. Confirm the finished dimensions below.`;
          setImportHint(hint); setNotice(hint);
        } else {
          const hint = 'No read/pick notation in this filename. Your current values are retained; confirm Read, Pick and output size below.';
          setImportHint(hint); setNotice(hint);
        }
      }
      if (!preset && next.dpiX && next.dpiY && next.dpiX >= 10 && next.dpiY >= 10) {
        setUnit('in'); setPhysicalWidth(Number((next.width / next.dpiX).toFixed(4))); setPhysicalHeight(Number((next.height / next.dpiY).toFixed(4))); setSizeMode('physical');
      } else if (!preset) setSizeMode('pixels');
      setOutlineColor(suggestOutlineColor(next));
      setPendingFile(null);
    } catch (reason) { if (id === taskId.current) setError(message(reason)); }
    finally { if (id === taskId.current) setLoading(false); }
  };
  const loadSample = async () => {
    if (busy) return;
    const paired = sampleCatalog.samples.find(sample => sample.id === '42482-pallu');
    if (paired) { await loadLocalSample(paired); return; }
    try {
      setError('');
      const response = await fetch('/samples/pallu-source.png');
      if (!response.ok) throw new Error('The sample could not be loaded. Upload your PNG or BMP instead.');
      await importFile(new File([await response.blob()], '42482pallu (r96p52).png', { type: 'image/png' }), false, { id: '42482-pallu', label: '42482 · Pallu', sourceName: '42482pallu.png', sourceUrl: '/samples/pallu-source.png', read: 96, pick: 52, width: 768, height: 988, settingsSource: 'sized-bmp' });
    } catch (reason) { setError(message(reason)); }
  };
  const loadLocalSample = async (sample: SamplePreset) => {
    if (busy) return;
    try {
      setError('');
      const response = await fetch(sample.sourceUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('This source sample is unavailable. Refresh the local sample library and try again.');
      await importFile(new File([await response.blob()], sample.sourceName, { type: 'image/png' }), false, sample);
    } catch (reason) { setError(message(reason)); }
  };
  const run = async () => {
    if (!orientedSource || !sizeValid || busy) return;
    if (result && !await askConfirmation('Process the original again?', 'This replaces the current result and canvas edits. Download them first if you want to keep them.')) return;
    const id = ++taskId.current;
    setError(''); setNotice(''); setProgress({ stage: 'Preparing original artwork', percent: 0 });
    const settings = { ...options, protectedColors: [...protectedColors] };
    try {
      const processing = processImage(orientedSource, settings, next => { if (taskId.current === id) setProgress(next); });
      job.current = processing;
      const next = await processing.promise;
      if (taskId.current !== id) return;
      setResult(next); setResultOptions(settings); setResultOrientation(sourceOrientation); setHistory({ images: [next.image], index: 0 }); setMode('cleaned'); setTool('pan'); setSelectedColor(0); setReplaceFrom(0);
      setNotice('Cleanup complete. Review small details, then finish colors on the canvas.');
    } catch (reason) { if (taskId.current === id) setError(message(reason)); }
    finally { if (taskId.current === id) { setProgress(null); job.current = null; } }
  };
  const cancel = () => { taskId.current++; job.current?.cancel(); job.current = null; setProgress(null); setLoading(false); setNotice('Processing cancelled. Your original and previous result are unchanged.'); };
  const runAi = async () => {
    if (!edited || !resultOptions || busy || exporting || dirtySettings) return;
    const input = edited;
    const id = ++aiTaskId.current;
    setAiBaseline(input); setAiError(''); setNotice(''); setTool('pan'); setMode('cleaned');
    setAiProgress({ stage: 'Preparing the AI trial', percent: 0 });
    try {
      const processing = analyzeWithAi(input, { ...resultOptions, protectedColors: [...resultOptions.protectedColors] }, next => { if (aiTaskId.current === id) setAiProgress(next); });
      aiJob.current = processing;
      const next = await processing.promise;
      if (aiTaskId.current !== id) return;
      if (next.image.width !== input.width || next.image.height !== input.height || next.image.pixels.length !== input.pixels.length || next.changes.length !== input.pixels.length || next.image.palette.length !== input.palette.length || next.image.palette.some((color, index) => color.some((channel, c) => channel !== input.palette[index][c]))) throw new Error('The AI trial returned an incompatible image. Your canvas is unchanged.');
      setAiPreview(next); setAiView('proposal');
    } catch (reason) {
      if (aiTaskId.current === id) { setAiError(message(reason)); setAiBaseline(null); }
    } finally {
      if (aiTaskId.current === id) { setAiProgress(null); aiJob.current = null; }
    }
  };
  const cancelAi = () => {
    aiTaskId.current++; aiJob.current?.cancel(); aiJob.current = null;
    setAiProgress(null); setAiPreview(null); setAiBaseline(null); setAiError('');
    setNotice('AI trial cancelled. Your canvas is unchanged.');
  };
  const discardAi = () => {
    setAiPreview(null); setAiBaseline(null); setAiError(''); setMode('cleaned');
    setNotice('AI preview closed. Your canvas is unchanged.');
  };
  const applyAi = () => {
    if (!aiPreview || !aiBaseline || edited !== aiBaseline || aiProgress) return;
    commit(aiPreview.image);
    setAiPreview(null); setAiBaseline(null); setAiError(''); setMode('cleaned');
    setNotice('AI changes applied. Undo restores the canvas from before this trial.');
  };
  const runRegions = async () => {
    if (!edited || !resultOptions || busy || exporting || dirtySettings) return;
    const input = edited, id = ++regionTaskId.current;
    setRegionBaseline(input); setRegionError(''); setNotice(''); setTool('pan'); setMode('cleaned');
    setRegionProgress({ stage: 'Preparing full-canvas region analysis', percent: 0 });
    try {
      const processing = analyzeRegions(input, { ...resultOptions, protectedColors: [...resultOptions.protectedColors], flattenTexture: true }, next => { if (regionTaskId.current === id) setRegionProgress(next); });
      regionJob.current = processing;
      const next = await processing.promise;
      if (regionTaskId.current !== id) return;
      // Validate proposals against the frozen canvas before exposing a selectable preview.
      applyTextureRegions(input, next.proposals);
      setRegions(next); setSelectedRegions(next.proposals.map(p => p.id)); setRegionView('proposal');
      if (next.proposals[0]) setFocusRegion({ ...next.proposals[0].bounds, token: ++focusToken.current });
    } catch (reason) { if (regionTaskId.current === id) { setRegionError(message(reason)); setRegionBaseline(null); } }
    finally { if (regionTaskId.current === id) { setRegionProgress(null); regionJob.current = null; } }
  };
  const cancelRegions = () => {
    regionTaskId.current++; regionJob.current?.cancel(); regionJob.current = null;
    setRegionProgress(null); setRegions(null); setRegionBaseline(null); setSelectedRegions([]); setRegionError(''); setFocusRegion(undefined);
    setNotice('Region analysis cancelled. Your canvas is unchanged.');
  };
  const discardRegions = () => {
    setRegions(null); setRegionBaseline(null); setSelectedRegions([]); setRegionError(''); setFocusRegion(undefined); setMode('cleaned');
    setNotice('Region preview closed. Your canvas is unchanged.');
  };
  const applyRegions = () => {
    if (!regionalImage || !regionBaseline || edited !== regionBaseline || regionProgress || !selectedRegions.length) return;
    commit(regionalImage);
    setRegions(null); setRegionBaseline(null); setSelectedRegions([]); setRegionError(''); setFocusRegion(undefined); setMode('cleaned');
    setNotice('Selected regions cleaned. Undo restores the whole previous canvas. You can now finish their colors.');
  };
  const inspectRegion = (id: number) => {
    const proposal = regions?.proposals.find(p => p.id === id);
    if (proposal) setFocusRegion({ ...proposal.bounds, token: ++focusToken.current });
  };
  const exportFile = async (format: 'bmp' | 'png') => {
    if (!edited || !resultOptions || busy || exporting) return;
    setExporting(true); setError('');
    try {
      const receipt = format === 'bmp' ? await downloadBlob(new Blob([new Uint8Array(encodeBmp(edited, resultOptions.read, resultOptions.pick))], { type: 'image/bmp' }), `${outputName}.bmp`) : await savePng(edited, `${outputName}.png`);
      setNotice(receipt.savedLocally ? `${format.toUpperCase()} saved in Loom Clean / output / exports. Browser download also requested.` : `${format.toUpperCase()} download requested with your current canvas edits.`);
    } catch (reason) { setError(message(reason)); }
    finally { setExporting(false); }
  };
  const addColor = () => {
    if (!edited || edited.palette.length >= 256 || busy) return;
    const rgb = hexRgb(newColor);
    const existing = edited.palette.findIndex(c => c.every((v, i) => v === rgb[i]));
    if (existing >= 0) { setSelectedColor(existing); return; }
    commit({ ...edited, palette: [...edited.palette, rgb] }); setSelectedColor(edited.palette.length);
  };
  const toggleProtect = (color: number) => setProtectedColors(colors => colors.includes(color) ? colors.filter(c => c !== color) : [...colors, color]);
  const activePalette = edited?.palette || source?.palette || [];
  const safeSelectedColor = Math.min(selectedColor, Math.max(0, activePalette.length - 1));
  return <div className="app-shell" onDragEnter={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true); } }} onDragOver={event => event.preventDefault()} onDragLeave={event => { event.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) setDragging(false); }} onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); const file = event.dataTransfer.files[0]; if (file) void importFile(file); }}>
    <header className="app-header" inert={confirmation !== null}>
      <a className="brand" href="#" onClick={event => event.preventDefault()} aria-label="Loom Clean workspace"><span className="brand-mark"><i /><i /><i /><i /></span><span>Loom<span className="brand-light">Clean</span><small>JACQUARD DESIGN STUDIO</small></span></a>
      <div className="header-divider" /><span className="workspace-title">Design workspace</span>
      <div className="header-right"><span className="local-badge"><span /> Runs on your device</span><span className="version-badge">LAB 01</span></div>
    </header>
    <div className="workspace" inert={confirmation !== null}>
      <aside className="setup-panel">
        <div className="panel-heading"><span className="eyebrow">YOUR DESIGN, REFINED</span><h1>Prepare your artwork<span>.</span></h1><p>Precise pixels. Ready for the next weave.</p></div>
        <section className="setting-section source-section">
          <div className="section-title"><span className="step">01</span><h2>Source artwork</h2><span className="section-side">PNG / BMP</span></div>
          <input ref={fileInput} type="file" disabled={busy} accept=".png,.bmp,image/png,image/bmp" className="visually-hidden" aria-label="Upload PNG or BMP artwork" onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />
          {source ? <div className="source-file"><Thumbnail image={source} /><div><strong title={source.name}>{source.name}</strong><span>{source.width.toLocaleString()} × {source.height.toLocaleString()} px</span><span>{source.palette.length} colors{source.originalColors > source.palette.length ? ` · reduced from ${source.originalColors.toLocaleString()}` : ' · palette preserved'}</span><button className="text-button" disabled={busy} onClick={() => fileInput.current?.click()}>Replace artwork <span>↗</span></button></div></div> : <button className="upload-zone" disabled={busy} onClick={() => fileInput.current?.click()}><span className="upload-icon"><Icon name="upload" size={23} /></span><strong>Upload artwork</strong><span>Choose a file or drop it anywhere</span><small>PNG or BMP · up to {MAX_SOURCE_PIXELS / 1_000_000} megapixels</small></button>}
          {source && importHint && <p className="field-hint import-hint">{importHint}</p>}
          {source && <div className="source-orientation"><label>Source orientation<select value={sourceOrientation} disabled={busy} onChange={event => setSourceOrientation(Number(event.target.value) as SourceOrientation)}><option value={0}>Original orientation</option><option value={90}>Rotate 90° clockwise</option><option value={180}>Rotate 180°</option><option value={270}>Rotate 270° clockwise</option></select></label><p className="field-hint">Rotates the input before cleanup. The output grid stays as entered.{result && ' Reprocess to apply orientation changes.'}</p>{activeSampleId === '42850-patto' && <p className="field-hint orientation-advice">This sample's sized file uses a rotated layout. Select 90° clockwise and review the source preview before processing.</p>}</div>}
          <details className="import-options"><summary>Import color options</summary><label>Palette on import<select value={maxColors} disabled={busy} onChange={event => setMaxColors(Number(event.target.value))}><option value={0}>Preserve exact source colors</option>{[8, 16, 32, 64, 128, 256].map(n => <option value={n} key={n}>Reduce to at most {n} colors</option>)}</select></label><p>Reduction is optional and changes source colors. Required only above 256 colors.</p>{pendingFile && <button className="small-button" disabled={busy} onClick={() => void importFile(pendingFile, true)}>Retry import</button>}</details>
        </section>
        <section className="setting-section sample-library-section">
          <details className="sample-library">
            <summary>Local sample library <span>{sampleCatalog.samples.length}</span></summary>
            <p className="field-hint">The sized BMP supplies the output grid; only the original PNG is processed. The reference may use a rotated or rearranged layout—verify orientation in the preview.</p>
            <button className="sample-refresh" disabled={catalogLoading || busy} onClick={() => void refreshSamples()}><Icon name="reset" size={13} />{catalogLoading ? 'Reading sample folder…' : 'Refresh samples'}</button>
            {catalogError && <p className="field-hint error-text">{catalogError}</p>}
            <div className="sample-list">{sampleCatalog.samples.map(sample => <button key={sample.id} className="local-sample-button" disabled={busy} onClick={() => void loadLocalSample(sample)}><span><strong>{sample.label}</strong><small>R{sample.read} / P{sample.pick} · {sample.width.toLocaleString()} × {sample.height.toLocaleString()} px</small></span><Icon name="arrow" size={15} /></button>)}</div>
            {!catalogLoading && !catalogError && sampleCatalog.samples.length === 0 && <p className="field-hint">Add a source PNG and its SIZED BMP to the project's sample folder, then refresh.</p>}
            {sampleCatalog.warnings.map((warning, index) => <p key={index} className="field-hint error-text">{warning}</p>)}
          </details>
        </section>
        <section className="setting-section">
          <div className="section-title"><span className="step">02</span><h2>Output size</h2></div>
          <div className="field-pair"><label>Read <span>per inch</span><input type="number" value={read || ''} min={1} max={5000} disabled={busy} onChange={event => setRead(Number(event.target.value))} /></label><label>Pick <span>per inch</span><input type="number" value={pick || ''} min={1} max={5000} disabled={busy} onChange={event => setPick(Number(event.target.value))} /></label></div>
          <div className="segmented size-segment" aria-label="Size entry method"><button className={sizeMode === 'physical' ? 'active' : ''} onClick={() => { if (sizeMode === 'pixels' && read > 0 && pick > 0) { setPhysicalWidth(pixelWidth / read * (unit === 'cm' ? 2.54 : 1)); setPhysicalHeight(pixelHeight / pick * (unit === 'cm' ? 2.54 : 1)); } setSizeMode('physical'); }} disabled={busy}>Physical size</button><button className={sizeMode === 'pixels' ? 'active' : ''} onClick={() => { setPixelWidth(width); setPixelHeight(height); setSizeMode('pixels'); }} disabled={busy}>Exact pixels</button></div>
          <div className="dimensions-label"><span>{sizeMode === 'physical' ? 'Finished dimensions' : 'Final grid dimensions'}</span>{sizeMode === 'physical' ? <select aria-label="Dimension unit" value={unit} disabled={busy} onChange={event => { const next = event.target.value as 'in' | 'cm'; const factor = next === 'cm' ? 2.54 : 1 / 2.54; setPhysicalWidth(Number((physicalWidth * factor).toFixed(4))); setPhysicalHeight(Number((physicalHeight * factor).toFixed(4))); setUnit(next); }}><option value="in">inches</option><option value="cm">cm</option></select> : <span>px</span>}</div>
          <div className="field-pair dimension-pair"><label><span className="input-prefix">W</span><input aria-label="Output width" type="number" min={sizeMode === 'pixels' ? 1 : .01} step={sizeMode === 'pixels' ? 1 : .01} value={(sizeMode === 'pixels' ? pixelWidth : physicalWidth) || ''} disabled={busy} onChange={event => (sizeMode === 'pixels' ? setPixelWidth : setPhysicalWidth)(Number(event.target.value))} /></label><span className="times">×</span><label><span className="input-prefix">H</span><input aria-label="Output height" type="number" min={sizeMode === 'pixels' ? 1 : .01} step={sizeMode === 'pixels' ? 1 : .01} value={(sizeMode === 'pixels' ? pixelHeight : physicalHeight) || ''} disabled={busy} onChange={event => (sizeMode === 'pixels' ? setPixelHeight : setPhysicalHeight)(Number(event.target.value))} /></label></div>
          <div className={`output-size ${!sizeValid ? 'invalid' : ''}`}><span>OUTPUT GRID</span><strong>{Number.isFinite(width) ? width.toLocaleString() : '—'} <i>×</i> {Number.isFinite(height) ? height.toLocaleString() : '—'} <small>px</small></strong></div>
          {!sizeValid ? <p className="field-hint error-text">Use positive dimensions, up to {MAX_SIDE.toLocaleString()} px per side and {MAX_OUTPUT_PIXELS / 1_000_000} million pixels total. Read and pick: 1–5,000.</p> : <p className="field-hint">{source?.dpiX ? `Source metadata: ${shortNumber(source.dpiX)} DPI. Confirm the finished size before processing.` : 'Enter the intended size. Read and pick are used as pixels per inch.'}</p>}
        </section>
        <section className="setting-section cleanup-section">
          <div className="section-title"><span className="step">03</span><h2>Cleanup recipe</h2></div>
          <label className="label-row">Cleanup strength<span>{strength === 'gentle' ? 'Fewer changes' : strength === 'strong' ? 'More changes' : 'Recommended start'}</span></label>
          <div className="segmented strength-segment">{(['gentle', 'balanced', 'strong'] as const).map(value => <button key={value} className={strength === value ? 'active' : ''} disabled={busy} onClick={() => setStrength(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
          <label className="toggle-row"><div><strong>Flatten grainy shading</strong><span>Clean texture inside larger regions</span></div><input type="checkbox" checked={flattenTexture} disabled={busy} onChange={event => setFlattenTexture(event.target.checked)} /><i /></label>
          <label className="outline-label">Primary outline ink<select value={outlineColor === null ? '' : outlineColor} disabled={!source || busy} onChange={event => setOutlineColor(event.target.value === '' ? null : Number(event.target.value))}><option value="">No line repair</option>{source?.palette.map((color, index) => <option value={index} key={index}>Color {index + 1} · {rgbHex(color).toUpperCase()}</option>)}</select></label>
          {source && <p className="field-hint">A recurring dark ink is suggested. Choose the main outline ink. Line repair also checks other colors against the source; choose No line repair to disable all automatic connections.</p>}
          <details className="advanced-options"><summary>Detail protection & repeats <span>+</span></summary><div className="advanced-inner"><label>Protect colors</label><p className="field-hint">Selected colors are kept during automatic cleanup.</p><div className="protected-palette">{source ? source.palette.map((color, index) => <button key={index} disabled={busy} className={`protect-color ${protectedColors.includes(index) ? 'protected' : ''}`} style={{ '--swatch': rgbHex(color) } as React.CSSProperties} title={`Color ${index + 1}: ${protectedColors.includes(index) ? 'protected' : 'click to protect'}`} aria-label={`${protectedColors.includes(index) ? 'Unprotect' : 'Protect'} color ${index + 1}`} aria-pressed={protectedColors.includes(index)} onClick={() => toggleProtect(index)}>{protectedColors.includes(index) && <Icon name="check" size={14} />}</button>) : <span className="field-hint">Upload artwork to choose colors.</span>}</div><label className="check-row"><input type="checkbox" checked={repeatX} disabled={busy} onChange={event => setRepeatX(event.target.checked)} /> Wrap left / right edges</label><label className="check-row"><input type="checkbox" checked={repeatY} disabled={busy} onChange={event => setRepeatY(event.target.checked)} /> Wrap top / bottom edges</label><p className="field-hint">Enable only for a repeating tile. Leave off for a full pallu panel.</p></div></details>
        </section>
        <div className="process-footer"><button className="process-button" disabled={!source || !sizeValid || busy} onClick={() => void run()}><Icon name="sparkle" />{progress ? 'Refining pixels…' : result ? 'Reprocess original' : 'Clean artwork'}<Icon name="arrow" /></button><span>{source ? 'Your source file always stays intact' : 'Upload an artwork to get started'}</span></div>
      </aside>
      <main className="studio">
        <div className="studio-heading"><div><span className="eyebrow">{result ? 'REVIEW & FINISH' : 'THE CANVAS'}</span><h2>{source ? source.name.replace(/\.[^.]+$/, '') : 'Every pixel has a purpose.'}</h2></div>{source && <div className="studio-meta"><span>{result ? `${result.image.width} × ${result.image.height}` : `${orientedSource?.width} × ${orientedSource?.height}`}</span><span>{activePalette.length} colors</span></div>}</div>
        {error && <div className="message-banner error-banner" role="alert"><span>{error}{pendingFile && ' Open Import color options to choose a palette reduction and retry if needed.'}</span><button aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={16} /></button></div>}
        {notice && <div className="message-banner notice-banner" role="status"><Icon name="check" size={16} /><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice('')}><Icon name="close" size={16} /></button></div>}
        <div className="canvas-toolbar"><div className="view-tabs" aria-label="Comparison mode">{(['original', 'cleaned', 'changes'] as const).map((view, index) => <button key={view} disabled={!result || busy} className={(result ? mode === view : view === 'original') ? 'active' : ''} onClick={() => setMode(view)} title={`${view === 'original' ? 'Original resized to the output grid' : view === 'changes' ? 'All changed pixels, including your edits' : 'Cleaned output with your edits'} (${index + 1})`}>{view === 'original' ? 'Sized original' : view === 'cleaned' ? 'Cleaned' : 'Changes'}{view === 'changes' && <i />}</button>)}</div><div className="toolbar-tools"><button disabled={history.index <= 0 || busy} onClick={undo} title="Undo (Ctrl Z)" aria-label="Undo"><Icon name="undo" /></button><button disabled={history.index >= history.images.length - 1 || busy} onClick={redo} title="Redo (Ctrl Shift Z)" aria-label="Redo"><Icon name="redo" /></button><span className="tool-divider" /><label className="physical-toggle"><input type="checkbox" checked={physicalPreview} disabled={!displayedImage || busy} onChange={event => setPhysicalPreview(event.target.checked)} />Cloth proportions</label></div></div>
        <div className={`canvas-body ${reviewActive ? "ai-preview-active" : ""}`}>
          {reviewActive && <div className="ai-canvas-label">{regionReviewActive ? regionProgress ? "FINDING NOISY REGIONS · CANVAS UNCHANGED" : regionView === "before" ? "BEFORE REGION CLEANUP" : regionView === "changes" ? "REGION CHANGES · NOT APPLIED" : "REGION PROPOSALS · NOT APPLIED" : aiProgress ? "AI TRIAL RUNNING · CANVAS UNCHANGED" : aiView === "before" ? "BEFORE AI" : aiView === "changes" ? "AI CHANGES ONLY · NOT APPLIED" : "AI PROPOSAL · NOT APPLIED"}</div>}
          {displayedImage ? <><div className="floating-tools" role="toolbar" aria-label="Canvas tools">{([{ id: 'pan', label: 'Pan', shortcut: 'H' }, { id: 'fill', label: 'Fill connected region', shortcut: 'F' }, { id: 'pencil', label: 'One-pixel pencil', shortcut: 'B' }, { id: 'pick', label: 'Eyedropper', shortcut: 'I' }] as const).map(item => <button className={tool === item.id ? 'active' : ''} disabled={(busy && !(reviewActive && item.id === 'pan')) || (!edited || mode !== 'cleaned') && (item.id === 'fill' || item.id === 'pencil')} onClick={() => setTool(item.id)} title={`${item.label} (${item.shortcut})`} aria-label={item.label} aria-pressed={tool === item.id} key={item.id}><Icon name={item.id} /></button>)}</div><CanvasEditor image={displayedImage} baseline={regions ? regionBaseline || undefined : aiPreview ? aiBaseline || undefined : baseline} automaticImage={regions ? regionalImage || undefined : aiPreview?.image || result?.image} changeKinds={regions ? undefined : aiPreview ? aiChangeKinds : result?.changes} focusRegion={regions ? focusRegion : undefined} highlightRegions={regionHighlights} mode={canvasMode} tool={tool} selectedColor={safeSelectedColor} editable={!!edited && !busy} physical={physicalPreview} read={resultOptions?.read || orientedSource?.dpiX || 1} pick={resultOptions?.pick || orientedSource?.dpiY || 1} onChange={commit} onPick={setSelectedColor} /></> : <div className="empty-canvas"><div className="empty-motif"><span /><span /><span /><span /><div><Icon name="sparkle" size={28} /></div></div><span className="eyebrow">FROM ARTWORK TO WEAVE-READY PIXELS</span><h3>Start with your artwork.</h3><p>Set the weave dimensions. Refine the pixels.<br />Make the final color decisions yours.</p><button className="empty-upload" disabled={busy} onClick={() => fileInput.current?.click()}><Icon name="upload" size={17} /> Choose PNG or BMP <Icon name="arrow" size={17} /></button><div className="sample-divider"><span />or explore a real design<span /></div><button className="sample-card" disabled={busy} onClick={() => void loadSample()}><img src="/samples/pallu-source.png" alt="Floral pallu sample with dancer motifs" /><div><strong>Try the pallu sample</strong><span>7 colors · R96 / P52 · 8 × 19 in</span></div><Icon name="arrow" size={18} /></button><div className="privacy-note"><Icon name="shield" size={14} /> Your artwork stays on this device. No cloud uploads.</div></div>}
          {(progress || loading) && <div className="processing-overlay"><div className="processing-card"><div className="processing-symbol"><Icon name="sparkle" size={30} /></div><span className="eyebrow">{loading ? 'READING ARTWORK' : 'REFINING YOUR DESIGN'}</span><h3>{loading ? 'Building your palette…' : progress!.stage}</h3><div className="progress-track"><i style={{ width: `${loading ? 30 : Math.max(0, Math.min(100, progress!.percent))}%` }} /></div><p>{loading ? 'Reading pixels locally in your browser' : `${Math.round(progress!.percent)}% · processing the original source`}</p>{progress && <button className="small-button" onClick={cancel}>Cancel processing</button>}</div></div>}
        </div>
        <div className="canvas-bottom"><span className="canvas-instruction">{reviewActive ? 'Review the proposed areas · pan and zoom · apply selected changes or discard to continue editing' : !source ? 'A considered finish, down to the last pixel.' : mode !== 'cleaned' && result ? 'Inspect this view · switch to Cleaned to edit' : tool === 'fill' ? 'Choose a color, then click a connected region to fill' : tool === 'pencil' ? 'Drag to draw a continuous one-pixel stroke' : tool === 'pick' ? 'Click any pixel to pick its palette color' : 'Scroll to zoom · drag to pan · hold Space with any tool'}</span>{source && <span className="pixel-badge"><i /> ZOOM FOR PIXEL INSPECTION</span>}</div>
        <div className="output-bar"><div className="output-status"><span className={`status-dot ${result ? 'ready' : ''}`} /><div><strong>{regions ? 'Review the noisy regions' : regionProgress ? 'Finding noisy regions' : aiPreview ? 'Review the AI proposal' : aiProgress ? 'AI trial running' : result ? dirtySettings ? 'Settings changed' : 'Ready for your finishing touch' : 'Your next weave starts here'}</strong><span>{reviewActive ? 'Your committed canvas is unchanged. Downloads resume after this review.' : result ? dirtySettings ? 'Reprocess to apply the new recipe. Downloads use the current canvas.' : `${result.stats.changedPixels.toLocaleString()} pixels changed · ${(result.stats.elapsedMs / 1000).toFixed(1)}s · review fine details before use` : 'Cleaned, indexed BMP output for NedGraphics'}</span></div></div><div className="output-actions">{result && <button className="new-output-button" disabled={busy} onClick={async () => { if (await askConfirmation('Start a new output?', 'Start again from the original source with a fresh canvas. Download the current result first to keep it.')) clearOutput(); }}><Icon name="reset" size={15} /> New output</button>}<button className="png-button" disabled={!edited || busy || exporting} onClick={() => void exportFile('png')}>PNG</button><button className="export-button" disabled={!edited || busy || exporting} onClick={() => void exportFile('bmp')}><Icon name="download" size={17} />{exporting ? 'Preparing…' : 'Export BMP'}</button></div></div>
      </main>
      {displayedImage && <aside className="inspector-panel">
        {result && edited && <><RegionReview progress={regionProgress} result={regions} selectedIds={selectedRegions} view={regionView} error={regionError} disabled={processingBusy || exporting || aiReviewActive} settingsChanged={dirtySettings} onRun={() => void runRegions()} onCancel={cancelRegions} onApply={applyRegions} onDiscard={discardRegions} onView={setRegionView} onToggle={id => setSelectedRegions(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id])} onFocus={inspectRegion} onSelectAll={() => setSelectedRegions(regions?.proposals.map(p => p.id) || [])} onSelectNone={() => setSelectedRegions([])} /><details className="pixel-trial-options" open={aiReviewActive || undefined}><summary>Small pixel model trial</summary><AiReview progress={aiProgress} result={aiPreview} view={aiView} error={aiError} disabled={processingBusy || exporting || regionReviewActive} settingsChanged={dirtySettings} onRun={() => void runAi()} onCancel={cancelAi} onApply={applyAi} onDiscard={discardAi} onView={setAiView} /></details></>}<div className="inspector-heading"><span className="eyebrow">FINISHING TOOLS</span><h2>Your color palette<span>{activePalette.length}</span></h2><p>{edited ? 'Select a color, then fill a region or draw.' : 'Source colors. Process the artwork to start editing.'}</p></div><div className="palette-grid">{activePalette.map((color, index) => <button key={index} disabled={busy} className={`palette-swatch ${safeSelectedColor === index ? 'active' : ''}`} onClick={() => setSelectedColor(index)} style={{ '--swatch': rgbHex(color) } as React.CSSProperties} title={`Color ${index + 1}: ${rgbHex(color).toUpperCase()}`} aria-label={`Select color ${index + 1}, ${rgbHex(color)}`} aria-pressed={safeSelectedColor === index}><span>{safeSelectedColor === index && <Icon name="check" size={18} />}</span><small>{String(index + 1).padStart(2, '0')}</small></button>)}</div><div className="selected-color"><i style={{ background: activePalette[safeSelectedColor] ? rgbHex(activePalette[safeSelectedColor]) : '#000' }} /><div><span>SELECTED INK</span><strong>{activePalette[safeSelectedColor] ? rgbHex(activePalette[safeSelectedColor]).toUpperCase() : '—'}</strong></div><small>{safeSelectedColor + 1}</small></div>
        <div className="inspector-section"><h3>Add a color</h3><div className="add-color"><input type="color" aria-label="New palette color" value={newColor} disabled={!edited || busy || activePalette.length >= 256} onChange={event => setNewColor(event.target.value)} /><span>{newColor.toUpperCase()}</span><button disabled={!edited || busy || activePalette.length >= 256} onClick={addColor}>Add</button></div>{activePalette.length >= 256 && <p className="field-hint">Palette full: 256 colors.</p>}</div>
        <div className="inspector-section"><h3>Replace across the design</h3><p>Swap every pixel of one color with the selected ink.</p><label>Replace color<select disabled={!edited || busy} value={Math.min(replaceFrom, activePalette.length - 1)} onChange={event => setReplaceFrom(Number(event.target.value))}>{activePalette.map((color, index) => <option key={index} value={index}>Color {index + 1} · {rgbHex(color).toUpperCase()}</option>)}</select></label><div className="replace-preview"><i style={{ background: activePalette[Math.min(replaceFrom, activePalette.length - 1)] ? rgbHex(activePalette[Math.min(replaceFrom, activePalette.length - 1)]) : '#000' }} /><Icon name="arrow" size={16} /><i style={{ background: activePalette[safeSelectedColor] ? rgbHex(activePalette[safeSelectedColor]) : '#000' }} /><span>Color {safeSelectedColor + 1}</span></div><button className="replace-button" disabled={!edited || busy || replaceFrom === safeSelectedColor || mode !== 'cleaned'} onClick={() => edited && commit(replaceColor(edited, replaceFrom, safeSelectedColor))}>Replace all occurrences</button><p className="field-hint">For just one connected area, use the fill tool.</p></div>
        {result && <div className="inspector-section result-details"><h3>Cleanup report</h3><dl><div><dt>Changed pixels</dt><dd>{result.stats.changedPixels.toLocaleString()}</dd></div><div><dt>Speck fragments</dt><dd>{result.stats.specksRemoved.toLocaleString()}</dd></div><div><dt>Line pixels added</dt><dd>{result.stats.gapsRepaired.toLocaleString()}</dd></div><div><dt>Texture pixels cleaned</dt><dd>{result.stats.texturePixels.toLocaleString()}</dd></div>{result.stats.linePaths !== undefined && <div><dt>Traced line paths</dt><dd>{result.stats.linePaths.toLocaleString()}</dd></div>}</dl><p className="field-hint">Rule cleanup only; AI and canvas edits are separate. Counts do not measure design quality.</p>{result.warnings.length > 0 && <div className="review-notes"><strong>Review notes</strong>{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}</div>}
        <div className="inspector-tip"><Icon name="shield" size={18} /><p><strong>You direct the finish.</strong>Automatic cleanup preserves the palette. Recolor any region here before exporting.</p></div>
      </aside>}
    </div>
    {dragging && !busy && <div className="drop-overlay"><Icon name="upload" size={44} /><h2>Drop your artwork here</h2><p>PNG or BMP · processed on your device</p></div>}
    {confirmation && <div className="confirmation-overlay" onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); answerConfirmation(false); }
      if (event.key === 'Tab') {
        event.preventDefault();
        if (document.activeElement === keepEditingButton.current) continueButton.current?.focus();
        else keepEditingButton.current?.focus();
      }
    }}>
      <section className="confirmation-card" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-description">
        <span className="confirmation-icon"><Icon name="reset" size={25} /></span>
        <span className="eyebrow">KEEP YOUR WORK</span>
        <h2 id="confirmation-title">{confirmation.title}</h2>
        <p id="confirmation-description">{confirmation.description}</p>
        <div className="confirmation-actions"><button ref={keepEditingButton} className="keep-editing-button" onClick={() => answerConfirmation(false)}>Keep editing</button><button ref={continueButton} className="continue-button" onClick={() => answerConfirmation(true)}>Continue <Icon name="arrow" size={16} /></button></div>
      </section>
    </div>}
  </div>;
}
