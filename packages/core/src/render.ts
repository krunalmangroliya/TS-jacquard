import { faceAt, flattenEdge } from './topology';
import type { Bounds, Face, Geometry, Palette, PixelOverride, RenderResult, Repeat, RuleConfig, Vec2 } from './types';
import { DEFAULT_RULES } from './types';
import { applyRules, validateRuleGrid } from './rules';

const FIXED = 256;
const compareIds = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const area = (ring: Vec2[]): number => ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p.x * q.y - q.x * p.y; }, 0);

/** Indexed pixel-center rasterization using half-open scanline spans and 1/256 pixel coordinates. */
export function render(
  geometry: Geometry, faces: Face[], bounds: Bounds, palette: Palette, widthPx: number, heightPx: number,
  rules: RuleConfig = DEFAULT_RULES, overrides: PixelOverride[] = [], repeat: Repeat = { type: 'straight' },
): RenderResult {
  if (!Number.isFinite(bounds.w) || !Number.isFinite(bounds.h) || bounds.w <= 0 || bounds.h <= 0) throw new Error('Master bounds must be positive finite numbers.');
  if (!Number.isSafeInteger(widthPx) || !Number.isSafeInteger(heightPx) || widthPx < 1 || heightPx < 1 || widthPx * heightPx > 100_000_000) throw new Error('Output size must be positive integers with at most 100 million pixels.');
  let grid: Uint8Array = new Uint8Array(widthPx * heightPx);
  validateRuleGrid(grid, widthPx, heightPx, palette);
  const warnings: string[] = [], smallFacesRemoved: Vec2[] = [], visibleMask = new Uint8Array(grid.length), overrideMask = new Uint8Array(grid.length);
  const omittedFaceKeys = new Set<string>();
  const markOmittedDetail = (point: Vec2, face?: Face): void => {
    // A raster face can fragment into several tiny components, or a wrapped face
    // into multiple polygons. Report that logical face once, at a lost detail.
    const key = face ? `face:${face.seamGroup ?? face.id}` : `point:${point.x},${point.y}`;
    if (omittedFaceKeys.has(key)) return;
    omittedFaceKeys.add(key); smallFacesRemoved.push({ ...point });
  };
  const sx = widthPx / bounds.w, sy = heightPx / bounds.h;
  const transform = (p: Vec2): Vec2 => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('Geometry coordinates must be finite.');
    return { x: Math.round(p.x * sx * FIXED), y: Math.round(p.y * sy * FIXED) };
  };
  const checkColor = (color: number): number => {
    if (!Number.isInteger(color) || color < 0 || color >= palette.entries.length) throw new Error(`Color index ${color} is outside the palette.`);
    return color;
  };
  // A seam group is one face on the torus, even when represented by several clipped polygons.
  const seamColors = new Map<string, number>(), conflictedGroups = new Set<string>();
  for (const face of [...faces].sort(compareIds)) {
    const color = geometry.faceColors[face.id]?.colorIndex;
    if (!face.seamGroup || color == null) continue;
    checkColor(color);
    if (!seamColors.has(face.seamGroup)) seamColors.set(face.seamGroup, color);
    else if (seamColors.get(face.seamGroup) !== color) conflictedGroups.add(face.seamGroup);
  }
  for (const group of [...conflictedGroups].sort()) warnings.push(`Conflicting colors in seam group ${group}; the first face by stable ID supplies the color.`);
  let unassignedFaces = 0;
  const faceColor = (face: Face): number => {
    const color = face.seamGroup && seamColors.has(face.seamGroup) ? seamColors.get(face.seamGroup)! : geometry.faceColors[face.id]?.colorIndex;
    if (color == null) { if (face.outer) unassignedFaces++; return 0; }
    return checkColor(color);
  };
  const ordered = [...faces].sort((a, b) => (a.outer ? 1 : 0) - (b.outer ? 1 : 0) || b.areaDu - a.areaDu || compareIds(a, b));
  for (const face of ordered) {
    const color = faceColor(face);
    if (!face.outer) { grid.fill(color); continue; }
    const outer = face.outer.map(transform), holes = face.holes.map(ring => ring.map(transform));
    const rings = [{ points: outer, sign: Math.sign(area(outer)) }, ...holes.map(points => ({ points, sign: -Math.sign(area(points)) }))];
    let ymin = Infinity, ymax = -Infinity;
    for (const p of outer) { ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y); }
    const minY = Math.max(0, Math.ceil((ymin - FIXED / 2) / FIXED));
    const maxY = Math.min(heightPx - 1, Math.ceil((ymax - FIXED / 2) / FIXED) - 1);
    let pixels = 0;
    for (let y = minY; y <= maxY; y++) {
      const center = y * FIXED + FIXED / 2, events: { x: number; delta: number }[] = [];
      for (const { points, sign } of rings) {
        if (!sign) continue;
        for (let i = 0; i < points.length; i++) {
          const a = points[i], b = points[(i + 1) % points.length];
          if (a.y <= center && center < b.y) events.push({ x: a.x + (center - a.y) * (b.x - a.x) / (b.y - a.y), delta: sign });
          else if (b.y <= center && center < a.y) events.push({ x: b.x + (center - b.y) * (a.x - b.x) / (a.y - b.y), delta: -sign });
        }
      }
      events.sort((a, b) => a.x - b.x || a.delta - b.delta);
      let winding = 0, previousX = 0;
      for (let i = 0; i < events.length;) {
        const x = events[i].x;
        if (winding !== 0) {
          const start = Math.max(0, Math.ceil((previousX - FIXED / 2) / FIXED)), end = Math.min(widthPx, Math.ceil((x - FIXED / 2) / FIXED));
          if (end > start) { grid.fill(color, y * widthPx + start, y * widthPx + end); pixels += end - start; }
        }
        while (i < events.length && events[i].x === x) winding += events[i++].delta;
        previousX = x;
      }
    }
    if (pixels === 0 && color !== 0) markOmittedDetail(face.ref, face);
  }

  const allEdges = Object.values(geometry.edges);
  for (const edge of allEdges) {
    if (!Number.isFinite(edge.width) || edge.width < 0) throw new Error(`Edge ${edge.id} width must be a finite nonnegative number.`);
    if (edge.widthMode !== undefined && edge.widthMode !== 'output' && edge.widthMode !== 'design') throw new Error(`Edge ${edge.id} has an unsupported width mode.`);
    if (edge.strokeHidden !== undefined && typeof edge.strokeHidden !== 'boolean') throw new Error(`Edge ${edge.id} strokeHidden must be a boolean.`);
  }
  const edges = allEdges.filter(edge => edge.width > 0 && !edge.strokeHidden).sort((a, b) => a.z - b.z || compareIds(a, b));
  let subpixelDesignStrokes = 0;
  for (const edge of edges) {
    const designWidth = edge.widthMode === 'design';
    const color = checkColor(edge.colorIndex ?? 0), radius = (designWidth ? edge.width : Math.max(1, edge.width)) * FIXED / 2, radius2 = radius * radius;
    const radiusX = designWidth ? radius * sx : radius, radiusY = designWidth ? radius * sy : radius;
    if (![radius2, radiusX, radiusY].every(Number.isFinite)) throw new Error(`Edge ${edge.id} width is too large to rasterize safely.`);
    if (designWidth && (edge.width * sx < 1 || edge.width * sy < 1)) subpixelDesignStrokes++;
    // A source-space circular stroke becomes an ellipse on a non-square loom
    // grid. Measure distance in inverse-scaled design coordinates, preserving
    // both the stroke body and its end caps; never average the two scale factors.
    const metricX = designWidth ? 1 / sx : 1, metricY = designWidth ? 1 / sy : 1;
    const points = flattenEdge(edge, geometry, 0.125 / Math.max(sx, sy)).map(transform);
    const offsetsX = repeat.type === 'straight' ? [-widthPx * FIXED, 0, widthPx * FIXED] : [0];
    const offsetsY = repeat.type === 'straight' ? [-heightPx * FIXED, 0, heightPx * FIXED] : [0];
    for (const ox of offsetsX) for (const oy of offsetsY) for (let i = 1; i < points.length; i++) {
      const a = { x: points[i - 1].x + ox, y: points[i - 1].y + oy }, b = { x: points[i].x + ox, y: points[i].y + oy };
      const x0 = Math.max(0, Math.ceil((Math.min(a.x, b.x) - radiusX - FIXED / 2) / FIXED));
      const x1 = Math.min(widthPx - 1, Math.floor((Math.max(a.x, b.x) + radiusX - FIXED / 2) / FIXED));
      const y0 = Math.max(0, Math.ceil((Math.min(a.y, b.y) - radiusY - FIXED / 2) / FIXED));
      const y1 = Math.min(heightPx - 1, Math.floor((Math.max(a.y, b.y) + radiusY - FIXED / 2) / FIXED));
      const dx = b.x - a.x, dy = b.y - a.y, mdx = dx * metricX, mdy = dy * metricY, length2 = mdx * mdx + mdy * mdy;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x * FIXED + FIXED / 2, py = y * FIXED + FIXED / 2;
        const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * metricX * mdx + (py - a.y) * metricY * mdy) / length2));
        const ex = (px - (a.x + t * dx)) * metricX, ey = (py - (a.y + t * dy)) * metricY, distance2 = ex * ex + ey * ey;
        if (distance2 < radius2 || (distance2 === radius2 && (ey < 0 || (ey === 0 && ex < 0)))) {
          const p = y * widthPx + x; grid[p] = color; visibleMask[p] = 1;
        }
      }
    }
  }
  if (subpixelDesignStrokes) warnings.push(`${subpixelDesignStrokes} source-scaled stroke(s) are thinner than one output pixel along at least one grid axis; some details may not sample at this size.`);
  const validOverrides: PixelOverride[] = [];
  for (const override of overrides) {
    if (!Number.isInteger(override.x) || !Number.isInteger(override.y) || override.x < 0 || override.y < 0 || override.x >= widthPx || override.y >= heightPx) continue;
    checkColor(override.colorIndex); validOverrides.push(override); overrideMask[override.y * widthPx + override.x] = 1;
  }
  const result = applyRules(grid, widthPx, heightPx, palette, rules, visibleMask, repeat, overrideMask);
  grid = result.grid;
  for (const override of validOverrides) grid[override.y * widthPx + override.x] = override.colorIndex;
  for (const point of result.smallRegionsRemoved) {
    const designPoint = { x: point.x / sx, y: point.y / sy };
    markOmittedDetail(designPoint, faceAt(faces, designPoint));
  }
  warnings.push(...result.warnings);
  if (unassignedFaces) warnings.push(`${unassignedFaces} unassigned face(s) exported as ground color 0.`);
  if (smallFacesRemoved.length) warnings.push(`${smallFacesRemoved.length} region(s) have details omitted at this size; inspect the removed-detail markers.`);
  validateRuleGrid(grid, widthPx, heightPx, palette);
  const usedColors=new Uint8Array(palette.entries.length),colorsUsed:number[]=[];
  for(let i=0;i<grid.length;i++)usedColors[grid[i]]=1;
  for(let color=0;color<usedColors.length;color++)if(usedColors[color])colorsUsed.push(color);
  return { grid, report: { unassignedFaces, changedPixelsByRule: result.changedPixelsByRule, changedPixelsMask: result.changedPixelsMask, colorsUsed, smallFacesRemoved, warnings } };
}
