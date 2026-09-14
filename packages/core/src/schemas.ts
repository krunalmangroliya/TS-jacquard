import { z } from 'zod';
import { MAX_COLORS, type Master, type Palette } from './types';
const finite = z.number().finite();
const point = z.object({ x: finite, y: finite });
const rgb = z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]);
const legacyPaletteSchema = z.object({ entries: z.array(z.object({ index: z.number().int().min(0).max(15), name: z.string(), displayRgb: rgb, exportRgb: rgb })).min(1).max(16) });
export const paletteSchema = legacyPaletteSchema.extend({ entries: legacyPaletteSchema.shape.entries.max(MAX_COLORS, 'A design can use at most six colors, including ground and strokes') });
export const profileSchema = z.object({ id: z.string(), name: z.string(), hooks: z.number().int().positive(), epi: finite.positive(), ppi: finite.positive(), notes: z.string().optional() });
export const ruleSchema = z.object({ minRegionPx: z.number().int().min(0), minThicknessPx: z.number().int().min(0).max(8), removeCheckerboard: z.boolean(), connectVisibleEdges4: z.boolean(), protectedColorIndices: z.array(z.number().int().min(0).max(MAX_COLORS-1)).optional() });
export const traceParamsSchema = z.object({ inputMode: z.enum(['black-white', 'black-gold']).optional(), threshold: z.union([z.literal('otsu'), z.number().min(0).max(255)]), invert: z.boolean(), minSpeckArea: finite.min(0), gapClosePx: finite.min(0), spurPrunePx: finite.min(0), simplifyTolerance: finite.min(0), fitMaxError: finite.positive(), cornerAngleDeg: finite.min(0).max(180) });
export const geometrySchema = z.object({
  nodes: z.record(z.object({ id: z.string(), p: point, kind: z.enum(['corner','smooth']) })),
  edges: z.record(z.object({ id: z.string(), nodeIds: z.array(z.string()).min(2), segments: z.array(z.object({ c1: point.optional(), c2: point.optional() })), width: finite.min(0).max(8192), widthMode: z.enum(['output','design']).optional(), strokeHidden: z.boolean().optional(), colorIndex: z.number().int().min(0).max(15).optional(), z: finite })),
  faceColors: z.record(z.object({ colorIndex: z.number().int().min(0).max(15).nullable(), ref: point }))
});
export const masterSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), workspaceId: z.string(), name: z.string(), tags: z.array(z.string()),
  createdAt: z.string(), updatedAt: z.string(), bounds: z.object({ w: finite.min(8), h: finite.min(8) }),
  repeat: z.object({ type: z.enum(['none','straight','half-drop','brick']) }), palette: paletteSchema, geometry: geometrySchema,
  objects: z.array(z.object({ id: z.string(), name: z.string(), edgeIds: z.array(z.string()), locked: z.boolean(), hidden: z.boolean() })),
  source: z.object({ fileId: z.string(), widthPx: z.number().int().positive(), heightPx: z.number().int().positive(), crop: z.object({ x: finite, y: finite, w: finite.positive(), h: finite.positive() }).optional() }),
  traceParams: traceParamsSchema, version: z.number().int().positive()
});
export function validateMaster(value: unknown): Master {
  const master = masterSchema.parse(value);
  return validateReferences(master);
}
function validateReferences(master: Master): Master {
  const { geometry, palette } = master;
  if (palette.entries.some((entry, i) => entry.index !== i)) throw new Error('Palette indices must be contiguous from 0');
  for (const [id, node] of Object.entries(geometry.nodes)) if (id !== node.id) throw new Error(`Node key does not match id: ${id}`);
  for (const [id, edge] of Object.entries(geometry.edges)) {
    if (id !== edge.id || edge.segments.length !== edge.nodeIds.length - 1) throw new Error(`Invalid edge chain: ${id}`);
    if (edge.nodeIds.some((n, i) => !geometry.nodes[n] || (i > 0 && n === edge.nodeIds[i-1]))) throw new Error(`Missing or repeated edge node: ${id}`);
    if (edge.widthMode !== 'design' && edge.width > 8) throw new Error(`Output-pixel edge width exceeds 8: ${id}`);
    if (edge.colorIndex !== undefined && edge.colorIndex >= palette.entries.length) throw new Error(`Edge color is outside the palette: ${id}`);
    if (edge.width > 0 && edge.colorIndex === undefined) throw new Error(`Styled edge has no valid color: ${id}`);
  }
  for (const [id, color] of Object.entries(geometry.faceColors)) if (color.colorIndex !== null && color.colorIndex >= palette.entries.length) throw new Error(`Invalid face color: ${id}`);
  const owned = new Set<string>(), objectIds = new Set<string>();
  for (const object of master.objects) {
    if (objectIds.has(object.id)) throw new Error(`Duplicate object id: ${object.id}`); objectIds.add(object.id);
    for (const edgeId of object.edgeIds) { if (!geometry.edges[edgeId] || owned.has(edgeId)) throw new Error(`Edge ownership conflict: ${edgeId}`); owned.add(edgeId); }
  }
  if (owned.size !== Object.keys(geometry.edges).length) throw new Error('Every edge must belong to exactly one object');
  return master;
}

/** Explicit conversion for earlier 7–16-color masters; never silently drops colors. */
export function remapMasterPalette(value: unknown, palette: Palette, mapping: number[]): Master {
  const master = validateReferences(masterSchema.extend({palette:legacyPaletteSchema}).parse(value));
  const target = paletteSchema.parse(palette);
  if (mapping.length !== master.palette.entries.length || mapping.some(i => !Number.isInteger(i) || i < 0 || i >= target.entries.length)) throw new Error('Provide one valid target color for every old palette entry');
  for (const edge of Object.values(master.geometry.edges)) if (edge.colorIndex !== undefined) edge.colorIndex = mapping[edge.colorIndex];
  for (const face of Object.values(master.geometry.faceColors)) if (face.colorIndex !== null) face.colorIndex = mapping[face.colorIndex];
  master.palette = target;
  return validateMaster(master);
}
