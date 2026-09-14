import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import type { DesignRecord } from '../../../packages/app-model/src/index';
import type { MachineProfile } from '../../../packages/core/src/types';
import { materializeGeometry } from '../../../packages/core/src/materialize';
import { render } from '../../../packages/core/src/render';
import { resolveSize } from '../../../packages/core/src/size';
import { encodeBmp } from '../../../packages/core/src/bmp';
import { encodePng } from '../../../packages/core/src/png';
export interface ExportTask { document: DesignRecord; profile: MachineProfile; createdAt: string }
export interface ExportArtifacts { bmp: Uint8Array; png: Uint8Array; json: string; widthPx: number; heightPx: number }
export function renderDocument({ document, profile, createdAt }: ExportTask): ExportArtifacts {
  const { master } = document, materialized = materializeGeometry(master), size = resolveSize(master.bounds, profile, document.sizeInput);
  const rendered = render(materialized.geometry, materialized.faces, master.bounds, master.palette, size.widthPx, size.heightPx, document.rules, document.pixelOverrides, master.repeat);
  const bmp = encodeBmp(rendered.grid, size.widthPx, size.heightPx, master.palette, profile), png = encodePng(rendered.grid, size.widthPx, size.heightPx, master.palette);
  const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const sidecar = { app: 'JDM local', document: { id: document.id, name: document.name, kind: document.kind, revision: document.revision, masterId: document.masterId, baseMasterVersion: document.baseMasterVersion }, master: { id: master.id, version: master.version }, profile, ...size, palette: master.palette, rules: document.rules, pixelOverrides: document.pixelOverrides, colorsUsed: rendered.report.colorsUsed, changedPixelsByRule: rendered.report.changedPixelsByRule, smallFacesRemoved: rendered.report.smallFacesRemoved, unassignedFaces: rendered.report.unassignedFaces, warnings: [...materialized.warnings, ...size.warnings, ...rendered.report.warnings], bmpSha256: digest(bmp), pngSha256: digest(png), exportedAt: createdAt };
  return { bmp, png, json: JSON.stringify(sidecar, null, 2) + '\n', widthPx: size.widthPx, heightPx: size.heightPx };
}
if (parentPort && workerData) {
  try { const result = renderDocument(workerData as ExportTask); parentPort.postMessage({ ok: true, ...result }, [result.bmp.buffer as ArrayBuffer, result.png.buffer as ArrayBuffer]); }
  catch (error) { parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : 'Export failed' }); }
}
