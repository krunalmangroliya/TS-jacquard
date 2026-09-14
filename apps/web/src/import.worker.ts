import { traceImage } from '../../../packages/core/src/trace';
import { buildPlanarMap } from '../../../packages/core/src/topology';
import { goldFaceColors, traceGoldArtwork } from '../../../packages/core/src/gold-contours';
import type { Face, Geometry, Repeat, TraceParams, TraceResult } from '../../../packages/core/src/types';

export interface ImportJob { id: number; width: number; height: number; data: ArrayBuffer; params: Partial<TraceParams>; repeat: Repeat; strokeColorIndex: number }
export interface ImportResult { id: number; trace: TraceResult; faces: Face[]; path: string; warnings: string[]; elapsedMs: number }
function geometryPath(geometry: Geometry): string {
  const parts: string[] = [];
  for (const edge of Object.values(geometry.edges)) {
    const first = geometry.nodes[edge.nodeIds[0]].p; parts.push(`M${first.x} ${first.y}`);
    for (let i = 0; i < edge.segments.length; i++) {
      const a = geometry.nodes[edge.nodeIds[i]].p, b = geometry.nodes[edge.nodeIds[i + 1]].p, segment = edge.segments[i];
      if (segment.c1 || segment.c2) { const c1 = segment.c1 ?? a, c2 = segment.c2 ?? b; parts.push(`C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`); }
      else parts.push(`L${b.x} ${b.y}`);
    }
  }
  return parts.join(' ');
}
const scope = self as unknown as { onmessage: ((event: MessageEvent<ImportJob>) => void) | null; postMessage: (message: unknown) => void };
scope.onmessage = ({ data: job }) => {
  try {
    const started = performance.now(); scope.postMessage({ id: job.id, stage: job.params.inputMode === 'black-gold' ? 'Preserving gold shapes and fine dark details…' : 'Tracing lines and measuring widths…' });
    const input = { width: job.width, height: job.height, channels: 4 as const, data: new Uint8Array(job.data) };
    const gold = job.params.inputMode === 'black-gold' ? traceGoldArtwork(input, job.params) : undefined;
    const trace = gold?.trace ?? traceImage(input, job.params);
    for (const edge of Object.values(trace.geometry.edges)) edge.colorIndex = job.strokeColorIndex;
    scope.postMessage({ id: job.id, stage: 'Finding enclosed regions…' });
    const topology = buildPlanarMap(trace.geometry, { w: job.width, h: job.height }, job.repeat);
    trace.report.faces = topology.faces.filter(face => face.outer !== null).length;
    trace.geometry.faceColors = gold ? goldFaceColors(topology.faces, gold.binary, job.width, job.height, job.strokeColorIndex) : Object.fromEntries(topology.faces.map(face => [face.id, { colorIndex: face.outer === null || face.seamGroup === 'ground' ? 0 : null, ref: face.ref }]));
    scope.postMessage({ id: job.id, stage: 'Preparing your trace review…' });
    const result: ImportResult = { id: job.id, trace, faces: topology.faces, path: geometryPath(trace.geometry), warnings: [...new Set([...trace.report.warnings, ...topology.warnings])], elapsedMs: performance.now() - started };
    scope.postMessage({ id: job.id, result });
  } catch (error) { scope.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) }); }
};
