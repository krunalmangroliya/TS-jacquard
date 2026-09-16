export interface Vec2 { x: number; y: number }
export interface Bounds {
  w: number; h: number;
  /** Physical source pixel height / width; null means a prepared grid with unknown density. Undefined retains legacy artwork proportions. */
  pixelAspect?: number | null;
}
export interface SourceInterpretation {
  version: 1;
  kind: 'artwork' | 'loom-grid';
  /** User-confirmed horizontal ends and vertical picks per inch, in the stored image orientation. */
  density?: { epi: number; ppi: number };
}
export interface PaletteEntry { index: number; name: string; displayRgb: [number, number, number]; exportRgb: [number, number, number] }
export interface Palette { entries: PaletteEntry[] }
export interface Node { id: string; p: Vec2; kind: 'corner' | 'smooth' }
export interface BezierSegment { c1?: Vec2; c2?: Vec2 }
export interface Edge {
  id: string; nodeIds: string[]; segments: BezierSegment[]; width: number;
  /** Legacy widths are output pixels; traced widths scale with the design. */
  widthMode?: 'output' | 'design';
  /** Hiding ink preserves its width, geometry and separately editable fills. */
  strokeHidden?: boolean;
  colorIndex?: number; z: number;
}
export interface FaceColor { colorIndex: number | null; ref: Vec2 }
export interface Geometry { nodes: Record<string, Node>; edges: Record<string, Edge>; faceColors: Record<string, FaceColor> }
export interface DesignObject { id: string; name: string; edgeIds: string[]; locked: boolean; hidden: boolean }
export interface Face { id: string; outer: Vec2[] | null; holes: Vec2[][]; areaDu: number; ref: Vec2; seamGroup?: string }
export interface Repeat { type: 'none' | 'straight' | 'half-drop' | 'brick' }
export interface TopologyResult { faces: Face[]; warnings: string[]; vertices: number; segments: number; components: number }
export type TraceInputMode = 'black-white' | 'black-gold';
export interface TraceParams { inputMode?: TraceInputMode; threshold: number | 'otsu'; invert: boolean; minSpeckArea: number; gapClosePx: number; spurPrunePx: number; simplifyTolerance: number; fitMaxError: number; cornerAngleDeg: number }
export interface TraceReport { threshold: number; lineWidthEstimate: number; nodes: number; edges: number; objects: number; faces: number; openEnds: Vec2[]; autoClosed: { from: Vec2; to: Vec2 }[]; spursPruned: number; nodesPer1000du: number; warnings: string[] }
export interface RasterInput { width: number; height: number; data: Uint8Array; channels: 1 | 3 | 4 }
/** Original colored artwork stored as one palette index per source pixel. */
export interface IndexedRaster { width: number; height: number; pixelsBase64: string }
export interface TraceResult { geometry: Geometry; objects: DesignObject[]; report: TraceReport; params: TraceParams }
export interface MachineProfile { id: string; name: string; hooks: number; epi: number; ppi: number; notes?: string }
export type SizeInput =
  | { mode: 'physical'; unit: 'in' | 'cm'; width?: number; height?: number; linkAspect: boolean }
  | { mode: 'grid'; widthPx?: number; heightPx?: number; linkAspect: boolean }
  | { mode: 'fitAcross'; n: number };
export interface ResolvedSize { widthPx: number; heightPx: number; widthIn: number; heightIn: number; warnings: string[]; suggestedWidths: number[] }
export interface PixelOverride { x: number; y: number; colorIndex: number }
export interface CleanupRegion { x: number; y: number; w: number; h: number }
export interface RuleConfig {
  minRegionPx: number; minThicknessPx: number; removeCheckerboard: boolean; connectVisibleEdges4: boolean; protectedColorIndices?: number[];
  rasterResize?: 'nearest' | 'preserve-outline'; outlineColorIndex?: number; repairOutlineGaps?: boolean;
  /** Omitted on older documents to reproduce their original outline processing. */
  outlineAlgorithm?: 'legacy' | 'conservative';
  /** Explicit conservative gap-repair inks; 1–8 unique colors, independent of the preservation ink. */
  repairColorIndices?: number[];
  /** Restrict edits by the pixel color before any cleanup; undefined includes every color. */
  cleanupColorIndices?: number[];
  /** Normalized rectangle; membership is determined by output pixel centers. */
  cleanupRegion?: CleanupRegion;
}
export interface RenderReport { unassignedFaces: number; changedPixelsByRule: Record<string, number>; changedPixelsMask: Uint8Array; colorsUsed: number[]; colorPixelCounts?: number[]; smallFacesRemoved: Vec2[]; warnings: string[] }
export interface RenderResult { grid: Uint8Array; report: RenderReport }
export interface Master {
  schemaVersion: 1; id: string; workspaceId: string; name: string; tags: string[];
  createdAt: string; updatedAt: string; bounds: Bounds; repeat: Repeat; palette: Palette;
  geometry: Geometry; objects: DesignObject[]; raster?: IndexedRaster;
  source: { fileId: string; widthPx: number; heightPx: number; crop?: { x: number; y: number; w: number; h: number }; interpretation?: SourceInterpretation };
  traceParams: TraceParams; version: number;
}
/** One byte per indexed pixel, including ground and outline colors. */
export const MAX_COLORS = 256;
export const DEFAULT_PALETTE: Palette = { entries: [
  { index: 0, name: 'Ground', displayRgb: [248,244,234], exportRgb: [255,255,255] },
  { index: 1, name: 'Zari', displayRgb: [185,135,48], exportRgb: [255,200,0] },
  { index: 2, name: 'Red', displayRgb: [154,44,57], exportRgb: [255,0,0] },
  { index: 3, name: 'Leaf', displayRgb: [46,102,84], exportRgb: [0,160,0] },
  { index: 4, name: 'Indigo', displayRgb: [44,65,111], exportRgb: [0,0,255] },
  { index: 5, name: 'Outline', displayRgb: [38,35,39], exportRgb: [0,0,0] }
] };
export const DEFAULT_RULES: RuleConfig = { minRegionPx: 4, minThicknessPx: 0, removeCheckerboard: true, connectVisibleEdges4: true };
export const DEFAULT_RASTER_RULES: RuleConfig = { minRegionPx: 0, minThicknessPx: 0, removeCheckerboard: false, connectVisibleEdges4: false, rasterResize: 'nearest', repairOutlineGaps: false };
export const DEFAULT_PROFILE: MachineProfile = { id: 'placeholder-2400', name: 'Example 2400 / 60 / 48 (unverified)', hooks: 2400, epi: 60, ppi: 48 };
