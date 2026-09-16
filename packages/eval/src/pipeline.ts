import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildPlanarMap, trackFaces } from '../../core/src/topology';
import { traceImage } from '../../core/src/trace';
import { render } from '../../core/src/render';
import { encodeBmp } from '../../core/src/bmp';
import { encodePng } from '../../core/src/png';
import { resolveSize } from '../../core/src/size';
import { DEFAULT_PALETTE, DEFAULT_RULES, type Master, type MachineProfile, type TraceParams, type SizeInput, type RuleConfig, type PixelOverride, type Face, type Repeat } from '../../core/src/types';
import { validateMaster } from '../../core/src/schemas';
import { materializeGeometry } from '../../core/src/materialize';
import { readPng, writeJson, hash } from './io';

export async function traceFile(file: string, params: Partial<TraceParams> = {}, progress?: (message:string)=>void, repeat:Repeat={type:'straight'}) {
  const { raster, bytes, digest } = await readPng(file);
  const started = performance.now(), traced = traceImage(raster, params);
  progress?.(`Traced ${traced.report.nodes} nodes / ${traced.report.edges} edges; building regions ...`);
  const bounds = { w: raster.width, h: raster.height };
  const topology = buildPlanarMap(traced.geometry, bounds, repeat);
  traced.geometry.faceColors = Object.fromEntries(topology.faces.map(face => [face.id, { colorIndex: face.outer === null || face.seamGroup === 'ground' ? 0 : null, ref: face.ref }]));
  traced.report.faces = topology.faces.filter(face => face.outer !== null).length;
  traced.report.warnings.push(...topology.warnings);
  const now = new Date().toISOString();
  const master = validateMaster({ schemaVersion: 1, id: `master-${digest.slice(0,24)}`, workspaceId: 'local-pilot', name: path.basename(file, path.extname(file)), tags: [], createdAt: now, updatedAt: now, bounds, repeat, palette: JSON.parse(JSON.stringify(DEFAULT_PALETTE)), geometry: traced.geometry, objects: traced.objects, source: { fileId: digest, widthPx: raster.width, heightPx: raster.height }, traceParams: traced.params, version: 1 });
  return { master, report: traced.report, faces: topology.faces, traceMs: performance.now() - started, sourceBytes: bytes };
}

/** Assigns fixture colors only. These are not automatic yarn or weave decisions. */
export function fillPlaceholders(input: Master, preparedFaces?:Face[]): Master {
  const master = validateMaster(JSON.parse(JSON.stringify(input)));
  const faces = preparedFaces ?? buildPlanarMap(master.geometry, master.bounds, master.repeat).faces;
  // Keep the default outline visible against demonstration fills. Designers can
  // still assign any of the palette entries to a face through normal edits.
  const fillIndices=master.palette.entries.filter(entry=>entry.index!==0&&entry.name.toLowerCase()!=='outline').map(entry=>entry.index);
  if(!fillIndices.length&&master.palette.entries.length>1)fillIndices.push(1);
  const seamColors = new Map<string, number>(); let next = 0;
  for (const face of faces) {
    let color = 0;
    if (face.outer !== null && face.seamGroup !== 'ground' && fillIndices.length) {
      const group = face.seamGroup ?? face.id;
      if (!seamColors.has(group)) seamColors.set(group, fillIndices[next++ % fillIndices.length]);
      color = seamColors.get(group)!;
    }
    master.geometry.faceColors[face.id] = { colorIndex: color, ref: face.ref };
  }
  return validateMaster(master);
}

export function renderMaster(input: Master, profile: MachineProfile, sizeInput: SizeInput, rules: RuleConfig = DEFAULT_RULES, overrides: PixelOverride[] = [], prepared?:ReturnType<typeof materializeGeometry>) {
  const master = validateMaster(JSON.parse(JSON.stringify(input)));
  const topology = prepared ?? materializeGeometry(master);
  const size = resolveSize(master.bounds, profile, sizeInput);
  const started = performance.now();
  const result = render(topology.geometry, topology.faces, master.bounds, master.palette, size.widthPx, size.heightPx, rules, overrides, master.repeat, master.raster);
  const renderMs = performance.now() - started;
  result.report.warnings.push(...topology.warnings, ...size.warnings);
  const ignoredOverrides=overrides.filter(p=>p.x<0||p.y<0||p.x>=size.widthPx||p.y>=size.heightPx).length;
  if(ignoredOverrides)result.report.warnings.push(`${ignoredOverrides} pixel overrides were outside this output size and were ignored`);
  return { ...result, ...size, renderMs, faces: topology.faces, bmp: encodeBmp(result.grid, size.widthPx, size.heightPx, master.palette, profile), png: encodePng(result.grid, size.widthPx, size.heightPx, master.palette) };
}

export async function exportMaster(master: Master, profile: MachineProfile, sizeInput: SizeInput, outputFile: string, rules: RuleConfig = DEFAULT_RULES, overrides: PixelOverride[] = [], prepared?:ReturnType<typeof materializeGeometry>) {
  const result = renderMaster(master, profile, sizeInput, rules, overrides,prepared);
  const stem = outputFile.replace(/\.(bmp|png|json)$/i, '');
  await mkdir(path.dirname(stem), { recursive: true });
  await writeFile(`${stem}.bmp`, result.bmp); await writeFile(`${stem}.png`, result.png);
  const sidecar = {
    app: 'JDM 0.1.0 core prototype', master: { id: master.id, name: master.name, version: master.version },
    profile, widthPx: result.widthPx, heightPx: result.heightPx, widthIn: result.widthIn, heightIn: result.heightIn,
    palette: master.palette, rules, pixelOverrides: overrides, changedPixelsByRule: result.report.changedPixelsByRule,
    smallFacesRemoved: result.report.smallFacesRemoved, unassignedFaces: result.report.unassignedFaces,
    colorsUsed: result.report.colorsUsed, warnings: result.report.warnings,
    bmpSha256: hash(result.bmp), pngSha256: hash(result.png), exportedAt: new Date().toISOString()
  };
  await writeJson(`${stem}.json`, sidecar);
  const changed = new Uint8Array(result.grid.length);
  for (let i = 0; i < changed.length; i++) changed[i] = result.report.changedPixelsMask[i] ? 1 : 0;
  await writeFile(`${stem}.changes.png`, encodePng(changed, result.widthPx, result.heightPx, { entries: [
    { index: 0, name: 'Unchanged', displayRgb: [255,255,255], exportRgb: [255,255,255] },
    { index: 1, name: 'Changed by cleanup', displayRgb: [225,67,48], exportRgb: [225,67,48] }
  ] }));
  return { ...result, sidecar, stem };
}
