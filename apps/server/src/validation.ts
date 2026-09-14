import { z } from 'zod';
import { PNG } from 'pngjs';
import { paletteSchema, profileSchema, ruleSchema, validateMaster } from '../../../packages/core/src/schemas';
import { resolveSize } from '../../../packages/core/src/size';
import { operationSchema } from '../../../packages/core/src/ops';
import type { DesignRecord, WorkspaceSettings } from '../../../packages/app-model/src/index';

export class HttpError extends Error { constructor(public statusCode: number, message: string, public code = 'REQUEST_ERROR') { super(message); } }
export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/, 'Invalid ID');
export const clientSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid client ID');
export const mutationSchema = z.object({ expectedRevision: z.number().int().positive().safe(), clientId: clientSchema });
export const nameSchema = z.string().trim().min(1).max(160);
const finitePositive = z.number().finite().positive();
export const sizeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('physical'), unit: z.enum(['in', 'cm']), width: finitePositive.optional(), height: finitePositive.optional(), linkAspect: z.boolean() }),
  z.object({ mode: z.literal('grid'), widthPx: z.number().int().positive().safe().optional(), heightPx: z.number().int().positive().safe().optional(), linkAspect: z.boolean() }),
  z.object({ mode: z.literal('fitAcross'), n: z.number().int().positive().safe() }),
]);
export const workspaceSchema = z.object({
  name: nameSchema,
  profiles: z.array(profileSchema.extend({ id: idSchema, name: nameSchema, hooks: z.number().int().positive().max(1_000_000), epi: finitePositive.max(1_000_000), ppi: finitePositive.max(1_000_000) })).min(1).max(100),
  defaultProfileId: idSchema, defaultPalette: paletteSchema,
});
export function validateWorkspace(value: unknown): WorkspaceSettings {
  const settings = workspaceSchema.parse(value);
  if (new Set(settings.profiles.map(p => p.id)).size !== settings.profiles.length) throw new HttpError(400, 'Profile IDs must be unique');
  if (!settings.profiles.some(p => p.id === settings.defaultProfileId)) throw new HttpError(400, 'The default profile must exist');
  if (settings.defaultPalette.entries.some((entry, i) => entry.index !== i)) throw new HttpError(400, 'Palette indices must be contiguous from zero');
  return settings;
}
const recordSchema = z.object({
  id: idSchema, kind: z.enum(['master', 'size']), masterId: idSchema.optional(), baseMasterVersion: z.number().int().positive().optional(),
  name: nameSchema, tags: z.array(z.string().trim().min(1).max(80)).max(100), master: z.unknown(),
  profileId: idSchema, sizeInput: sizeSchema, rules: ruleSchema,
  pixelOverrides: z.array(z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), colorIndex: z.number().int().min(0).max(5) })).max(4_000_000),
  operations: z.array(operationSchema).max(100_000), revision: z.number().int().positive().safe(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export function validatedMaster(value: unknown) {
  try {
    const master = validateMaster(value);
    if (!Number.isSafeInteger(master.version) || master.version >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid master version');
    if (master.bounds.w > 8192 || master.bounds.h > 8192 || master.bounds.w * master.bounds.h > 40_000_000) throw new Error('Master bounds exceed 8192 per side or 40 million pixels');
    if (master.source.widthPx > 8192 || master.source.heightPx > 8192 || master.source.widthPx * master.source.heightPx > 40_000_000) throw new Error('Source dimensions exceed the image limits');
    return master;
  } catch (error) { if (error instanceof z.ZodError) throw error; throw new HttpError(400, error instanceof Error ? error.message : 'Invalid master'); }
}
export function validateRecord(value: unknown, workspace: WorkspaceSettings): DesignRecord {
  const parsed = recordSchema.parse(value), master = validatedMaster(parsed.master);
  if (parsed.kind === 'size' && (!parsed.masterId || !parsed.baseMasterVersion)) throw new HttpError(400, 'A size must name its base master and version');
  if (parsed.kind === 'master' && (parsed.masterId || parsed.baseMasterVersion)) throw new HttpError(400, 'A master cannot have a parent');
  const profile = workspace.profiles.find(p => p.id === parsed.profileId);
  if (!profile) throw new HttpError(400, 'The selected machine profile does not exist');
  let size;
  try { size = resolveSize(master.bounds, profile, parsed.sizeInput); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid output size'); }
  for (const pixel of parsed.pixelOverrides) if (pixel.x >= size.widthPx || pixel.y >= size.heightPx || pixel.colorIndex >= master.palette.entries.length) throw new HttpError(400, 'A pixel override is outside the output grid or palette');
  return { ...parsed, master } as DesignRecord;
}
export function validPng(bytes: Buffer, thumbnail = false): { width: number; height: number } {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new HttpError(400, 'A valid PNG is required');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), side = thumbnail ? 2048 : 8192, area = thumbnail ? 4_000_000 : 40_000_000;
  if (!width || !height || width > side || height > side || width * height > area || bytes.length > (thumbnail ? 16_000_000 : 110_000_000)) throw new HttpError(413, 'PNG dimensions or file size exceed the local image limit');
  try { const decoded = PNG.sync.read(bytes); if (decoded.width !== width || decoded.height !== height) throw new Error('Dimensions differ'); }
  catch { throw new HttpError(400, 'PNG data is corrupt or unsupported'); }
  return { width, height };
}
export function decodePng(value: string | undefined, thumbnail = false): Buffer | undefined {
  if (value === undefined) return undefined;
  if (!value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new HttpError(400, 'PNG data must be plain base64');
  const bytes = Buffer.from(value, 'base64'); validPng(bytes, thumbnail); return bytes;
}
