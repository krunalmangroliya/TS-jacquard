import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { drawLine, floodFill } from './editor';
import { overviewDimensions, previewTiles, renderPreviewRegion, visibleSourceRect } from './preview';
import type { IndexedImage } from './types';

export type EditorTool = 'pan' | 'fill' | 'pencil' | 'pick';
export type CompareMode = 'cleaned' | 'original' | 'changes';
export interface CanvasRegionBounds { x: number; y: number; width: number; height: number }
export interface CanvasFocusRegion extends CanvasRegionBounds { token: number }
export interface CanvasHighlightRegion extends CanvasRegionBounds { id: number; selected: boolean }

export function clipCanvasRegion(region: CanvasRegionBounds, image: { width: number; height: number }): CanvasRegionBounds | null {
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) return null;
  const x = Math.max(0, region.x), y = Math.max(0, region.y);
  const right = Math.min(image.width, region.x + region.width), bottom = Math.min(image.height, region.y + region.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Fits the full region with room for controls, retaining exact pixel zoom when it fits. */
export function regionFocusCamera(region: CanvasRegionBounds, viewport: { width: number; height: number }, image: { width: number; height: number }, yRatio = 1): { x: number; y: number; scale: number } | null {
  const clipped = clipCanvasRegion(region, image);
  if (!clipped || viewport.width <= 0 || viewport.height <= 0 || !Number.isFinite(yRatio) || yRatio <= 0) return null;
  const scale = Math.max(.01, Math.min(16, Math.max(1, viewport.width - 140) / clipped.width, Math.max(1, viewport.height - 120) / (clipped.height * yRatio)));
  return { x: viewport.width / 2 - (clipped.x + clipped.width / 2) * scale, y: viewport.height / 2 - (clipped.y + clipped.height / 2) * scale * yRatio, scale };
}

interface Props {
  image: IndexedImage;
  baseline?: IndexedImage;
  automaticImage?: IndexedImage;
  changeKinds?: Uint8Array;
  mode: CompareMode;
  tool: EditorTool;
  selectedColor: number;
  editable: boolean;
  physical: boolean;
  read: number;
  pick: number;
  focusRegion?: CanvasFocusRegion;
  highlightRegions?: ReadonlyArray<CanvasHighlightRegion>;
  onChange: (image: IndexedImage) => void;
  onPick: (color: number) => void;
}
export default function CanvasEditor(props: Props) {
  const { image, baseline, automaticImage, changeKinds, mode, tool, selectedColor, editable, physical, read, pick, focusRegion, highlightRegions, onChange, onPick } = props;
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tileCanvas = useRef<HTMLCanvasElement | null>(null);
  const viewportMeasured = useRef(false);
  const lastFocusToken = useRef<number | undefined>(undefined);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const [grid, setGrid] = useState(true);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [strokePreview, setStrokePreview] = useState<IndexedImage | null>(null);
  const space = useRef(false);
  const gesture = useRef<{ type: 'pan' | 'draw'; x: number; y: number; cameraX: number; cameraY: number; image?: IndexedImage } | null>(null);
  const yRatio = physical && read > 0 && pick > 0 ? read / pick : 1;
  const shownImage = mode === 'original' && baseline ? baseline : strokePreview || image;
  const previewStyle = useMemo(() => ({ changes: mode === 'changes', baseline, automaticImage, changeKinds }), [mode, baseline, automaticImage, changeKinds]);
  const overviewSize = overviewDimensions(shownImage.width, shownImage.height);
  const useOverview = camera.scale <= overviewSize.width / shownImage.width && camera.scale * yRatio <= overviewSize.height / shownImage.height;
  const overview = useMemo(() => {
    if (!useOverview) return null;
    const result = document.createElement('canvas');
    result.width = overviewSize.width; result.height = overviewSize.height;
    const rgba = renderPreviewRegion(shownImage, { x: 0, y: 0, width: shownImage.width, height: shownImage.height }, result.width, result.height, previewStyle);
    result.getContext('2d')!.putImageData(new ImageData(rgba, result.width, result.height), 0, 0);
    return result;
  }, [shownImage, previewStyle, useOverview, overviewSize.width, overviewSize.height]);
  const fit = useCallback(() => {
    const scale = Math.max(.01, Math.min((size.width - 100) / image.width, (size.height - 80) / (image.height * yRatio)));
    setCamera({ x: (size.width - image.width * scale) / 2, y: (size.height - image.height * scale * yRatio) / 2, scale });
  }, [size, image.width, image.height, yRatio]);
  useEffect(fit, [fit]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      viewportMeasured.current = true;
      setSize({ width: rect.width, height: rect.height });
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!focusRegion || !viewportMeasured.current || !Number.isFinite(focusRegion.token) || lastFocusToken.current === focusRegion.token) return;
    const next = regionFocusCamera(focusRegion, size, image, yRatio);
    if (!next) return;
    lastFocusToken.current = focusRegion.token;
    setCamera(next);
  }, [focusRegion, size, image.width, image.height, yRatio]);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, select, textarea, button')) return;
      if (event.code === 'Space') { space.current = true; event.preventDefault(); }
      if (event.key === '0') fit();
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') space.current = false; };
    const blur = () => { space.current = false; };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [fit]);
  const zoom = useCallback((factor: number, x = size.width / 2, y = size.height / 2) => {
    setCamera(current => {
      const scale = Math.max(.01, Math.min(64, current.scale * factor));
      const ratio = scale / current.scale;
      return { x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio, scale };
    });
  }, [size]);
  useEffect(() => {
    const element = canvas.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element!.getBoundingClientRect();
      zoom(Math.exp(-event.deltaY * .002), event.clientX - bounds.left, event.clientY - bounds.top);
    };
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => element?.removeEventListener('wheel', wheel);
  }, [zoom]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    // Keep high-DPI backing stores bounded without reducing native CSS-pixel inspection.
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_194_304 / Math.max(1, size.width * size.height))));
    element.width = Math.round(size.width * dpr); element.height = Math.round(size.height * dpr);
    const context = element.getContext('2d')!;
    context.scale(dpr, dpr);
    // Overview is filtered for readability; pixel inspection remains exact at 100%+.
    context.imageSmoothingEnabled = camera.scale < 1;
    context.imageSmoothingQuality = 'high';
    if (overview) {
      context.drawImage(overview, camera.x, camera.y, image.width * camera.scale, image.height * camera.scale * yRatio);
    } else {
      const visible = visibleSourceRect(shownImage, size, camera, yRatio);
      if (visible) {
        const tile = tileCanvas.current || (tileCanvas.current = document.createElement('canvas'));
        const samplingScale = Math.min(1, Math.max(camera.scale, camera.scale * yRatio) * dpr);
        for (const rect of previewTiles(visible)) {
          const tileWidth = Math.max(1, Math.ceil(rect.width * samplingScale));
          const tileHeight = Math.max(1, Math.ceil(rect.height * samplingScale));
          tile.width = tileWidth; tile.height = tileHeight;
          const rgba = renderPreviewRegion(shownImage, rect, tileWidth, tileHeight, previewStyle);
          tile.getContext('2d')!.putImageData(new ImageData(rgba, tileWidth, tileHeight), 0, 0);
          context.drawImage(tile, camera.x + rect.x * camera.scale, camera.y + rect.y * camera.scale * yRatio, rect.width * camera.scale, rect.height * camera.scale * yRatio);
        }
      }
    }
    if (grid && camera.scale >= 10 && camera.scale * yRatio >= 10) {
      context.strokeStyle = 'rgba(180, 180, 160, .32)'; context.lineWidth = .5;
      const x0 = Math.max(0, Math.floor(-camera.x / camera.scale));
      const x1 = Math.min(image.width, Math.ceil((size.width - camera.x) / camera.scale));
      const y0 = Math.max(0, Math.floor(-camera.y / (camera.scale * yRatio)));
      const y1 = Math.min(image.height, Math.ceil((size.height - camera.y) / (camera.scale * yRatio)));
      context.beginPath();
      for (let x = x0; x <= x1; x++) { context.moveTo(camera.x + x * camera.scale, Math.max(0, camera.y)); context.lineTo(camera.x + x * camera.scale, Math.min(size.height, camera.y + image.height * camera.scale * yRatio)); }
      for (let y = y0; y <= y1; y++) { context.moveTo(Math.max(0, camera.x), camera.y + y * camera.scale * yRatio); context.lineTo(Math.min(size.width, camera.x + image.width * camera.scale), camera.y + y * camera.scale * yRatio); }
      context.stroke();
    }
    if (highlightRegions?.length) {
      context.save();
      context.font = '600 11px system-ui, sans-serif'; context.textBaseline = 'middle';
      // Draw selected regions last so their boundaries stay visible at overlaps.
      for (const region of [...highlightRegions].sort((a, b) => Number(a.selected) - Number(b.selected))) {
        const rect = clipCanvasRegion(region, image);
        if (!rect) continue;
        const x = camera.x + rect.x * camera.scale, y = camera.y + rect.y * camera.scale * yRatio;
        const width = rect.width * camera.scale, height = rect.height * camera.scale * yRatio;
        if (x > size.width || y > size.height || x + width < 0 || y + height < 0) continue;
        context.setLineDash([]); context.lineWidth = 4; context.strokeStyle = '#172013d9';
        context.strokeRect(x, y, width, height);
        context.setLineDash(region.selected ? [] : [5, 4]); context.lineWidth = 2;
        context.strokeStyle = region.selected ? '#ceeaa3' : '#b1b6a9'; context.strokeRect(x, y, width, height);
        const label = `Region ${region.id}`, labelWidth = context.measureText(label).width + 14;
        const labelX = Math.max(6, Math.min(size.width - labelWidth - 6, x + 5));
        const labelY = Math.max(6, Math.min(size.height - 27, y + 5));
        context.setLineDash([]); context.fillStyle = region.selected ? '#ceeaa3' : '#343c2e';
        context.fillRect(labelX, labelY, labelWidth, 21);
        context.fillStyle = region.selected ? '#2c4220' : '#d1d8c5';
        context.fillText(label, labelX + 7, labelY + 10.5);
      }
      context.restore();
    }
  }, [overview, shownImage, previewStyle, size, camera, image.width, image.height, yRatio, grid, highlightRegions]);
  const point = (event: React.PointerEvent) => {
    const bounds = canvas.current!.getBoundingClientRect();
    const sx = event.clientX - bounds.left, sy = event.clientY - bounds.top;
    return { sx, sy, x: Math.floor((sx - camera.x) / camera.scale), y: Math.floor((sy - camera.y) / (camera.scale * yRatio)) };
  };
  const valid = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x < image.width && p.y < image.height;
  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    canvas.current!.setPointerCapture(event.pointerId);
    const p = point(event);
    if (tool === 'pan' || space.current || event.button === 1) {
      gesture.current = { type: 'pan', x: p.sx, y: p.sy, cameraX: camera.x, cameraY: camera.y }; return;
    }
    if (!valid(p)) return;
    if (tool === 'pick') { onPick(shownImage.pixels[p.y * image.width + p.x]); return; }
    if (!editable || mode !== 'cleaned') return;
    if (tool === 'fill') { onChange(floodFill(image, p.x, p.y, selectedColor)); return; }
    const next = drawLine(image, p.x, p.y, p.x, p.y, selectedColor);
    gesture.current = { type: 'draw', x: p.x, y: p.y, cameraX: 0, cameraY: 0, image: next };
    setStrokePreview(next);
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const p = point(event); setCursor(valid(p) ? { x: p.x, y: p.y } : null);
    const current = gesture.current;
    if (!current) return;
    if (current.type === 'pan') { setCamera(c => ({ ...c, x: current.cameraX + p.sx - current.x, y: current.cameraY + p.sy - current.y })); return; }
    const x = Math.max(0, Math.min(image.width - 1, p.x)), y = Math.max(0, Math.min(image.height - 1, p.y));
    const next = drawLine(current.image!, current.x, current.y, x, y, selectedColor);
    gesture.current = { ...current, x, y, image: next }; setStrokePreview(next);
  };
  const endStroke = () => {
    const current = gesture.current;
    if (current?.type === 'draw' && current.image && current.image !== image) onChange(current.image);
    gesture.current = null; setStrokePreview(null);
  };
  return <div className="canvas-host" ref={host}>
    <canvas ref={canvas} className={`design-canvas tool-${tool}`} aria-label={`${mode === 'original' ? 'Sized original' : mode === 'changes' ? 'Changed pixels' : 'Design'} canvas, ${image.width} by ${image.height} pixels`} tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={endStroke} onPointerCancel={endStroke} onLostPointerCapture={endStroke} onPointerLeave={() => setCursor(null)} />
    <div className="canvas-label">{mode === 'original' ? 'SIZED ORIGINAL' : mode === 'changes' ? 'CHANGED PIXELS' : editable ? 'CLEANED DESIGN' : 'SOURCE ARTWORK'}{physical && <span> · physical proportions</span>}</div>
    {mode === 'changes' && <div className="change-legend"><span><i className="legend-removal" /> Noise / texture removed</span><span><i className="legend-repair" /> Lines added</span><span><i className="legend-edit" /> Your edits</span></div>}
    <div className="canvas-render-mode">{camera.scale < 1 ? 'Smoothed overview · zoom to 100% for exact pixels' : 'Exact pixel view'}</div>
    <div className="canvas-position">{cursor ? `${cursor.x + 1}, ${cursor.y + 1} px` : `${image.width.toLocaleString()} × ${image.height.toLocaleString()} px`}</div>
    <div className="zoom-controls">
      <button onClick={() => zoom(1 / 1.4)} aria-label="Zoom out">−</button><span>{Math.round(camera.scale * 100)}%</span><button onClick={() => zoom(1.4)} aria-label="Zoom in">+</button><b />
      <button onClick={fit} title="Fit artwork (0)">Fit</button><button onClick={() => zoom(1 / camera.scale)} title="View one image pixel per screen pixel">1:1</button><b />
      <button className={grid ? 'selected' : ''} onClick={() => setGrid(v => !v)} title="Show pixel grid at 1000% zoom and above">Grid</button>
    </div>
  </div>;
}
