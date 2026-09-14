import type { MachineProfile, Master, RuleConfig } from '../../core/src/types';
import { materializeGeometry } from '../../core/src/materialize';
import { flattenEdge } from '../../core/src/topology';
import { render } from '../../core/src/render';
import { encodeBmp } from '../../core/src/bmp';
import { setStrokeVisibility } from '../../core/src/ops';
import { resolveSize } from '../../core/src/size';

type Request =
  | { type: 'init'; masterJson: string; profile: MachineProfile; rules: RuleConfig; widthPx: number; heightPx: number }
  | { type: 'visibility'; edgeId: string; hidden: boolean; revision: number }
  | { type: 'size'; widthPx: number; heightPx: number; revision: number }
  | { type: 'download'; format: 'master' | 'bmp'; revision: number };
const scope = self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void; onmessage: ((event: MessageEvent<Request>) => void) | null };
let master: Master, cached: ReturnType<typeof materializeGeometry>, profile: MachineProfile, rules: RuleConfig;
let widthPx = 0, heightPx = 0, revision = 0, grid: Uint8Array, topologyBuilds = 0;
let sizeWarnings: string[] = [], originalFlags = new Map<string, boolean>();
let saved: { fingerprint: string; version: number; updatedAt: string } | undefined;
function applySize(width: number, height: number): void {
  const size = resolveSize(master.bounds, profile, { mode: 'grid', widthPx: width, heightPx: height, linkAspect: false });
  widthPx = size.widthPx; heightPx = size.heightPx; sizeWarnings = size.warnings;
}
function preview(): void {
  const result = render(cached.geometry, cached.faces, master.bounds, master.palette, widthPx, heightPx, rules, [], master.repeat);
  grid = result.grid;
  const copy = grid.slice();
  scope.postMessage({ type: 'preview', revision, widthPx, heightPx, grid: copy.buffer, warnings: [...cached.warnings, ...sizeWarnings, ...result.report.warnings], topologyBuilds }, [copy.buffer]);
}
scope.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      master = JSON.parse(data.masterJson) as Master; profile = data.profile; rules = data.rules; applySize(data.widthPx, data.heightPx);
      originalFlags = new Map(Object.values(master.geometry.edges).map(edge => [edge.id, Boolean(edge.strokeHidden)]));
      scope.postMessage({ type: 'progress', message: 'Finding the design regions…' });
      cached = materializeGeometry(master); topologyBuilds++;
      const edges = Object.values(cached.geometry.edges).filter(edge => edge.width > 0).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const locked = new Set(master.objects.filter(object => object.locked).flatMap(object => object.edgeIds));
      const paths = edges.map(edge => flattenEdge(edge, cached.geometry, 0.35));
      const offsets = new Uint32Array(edges.length + 1), points = new Float32Array(paths.reduce((sum, path) => sum + path.length * 2, 0));
      let position = 0;
      paths.forEach((path, i) => { offsets[i] = position; for (const point of path) { points[position++] = point.x; points[position++] = point.y; } }); offsets[edges.length] = position;
      scope.postMessage({ type: 'strokes', ids: edges.map(edge => edge.id), hidden: edges.map(edge => Boolean(edge.strokeHidden)), locked: edges.map(edge => locked.has(edge.id)), offsets: offsets.buffer, points: points.buffer }, [offsets.buffer, points.buffer]);
      scope.postMessage({ type: 'progress', message: 'Rendering the loom pixels…' });
      preview(); return;
    }
    if (!master || !cached) throw new Error('The design is still loading.');
    if (data.type === 'visibility') {
      master = setStrokeVisibility(master, [data.edgeId], data.hidden);
      cached.geometry.edges[data.edgeId] = master.geometry.edges[data.edgeId];
      revision = data.revision; preview(); return;
    }
    if (data.type === 'size') {
      applySize(data.widthPx, data.heightPx); revision = data.revision; preview(); return;
    }
    if (data.type === 'download') {
      if (data.revision !== revision) throw new Error('Wait for the latest preview before downloading.');
      let exportedMaster = master;
      if (data.format === 'master') {
        const changedIds = Object.values(master.geometry.edges).filter(edge => Boolean(edge.strokeHidden) !== originalFlags.get(edge.id)).map(edge => edge.id).sort();
        const fingerprint = JSON.stringify(changedIds);
        if (changedIds.length) {
          if (!saved || saved.fingerprint !== fingerprint) saved = { fingerprint, version: (saved?.version ?? master.version) + 1, updatedAt: new Date().toISOString() };
          exportedMaster = { ...master, version: saved.version, updatedAt: saved.updatedAt };
        }
      }
      const bytes = data.format === 'master' ? new TextEncoder().encode(JSON.stringify(exportedMaster, null, 2) + '\n') : encodeBmp(grid, widthPx, heightPx, master.palette, profile);
      scope.postMessage({ type: 'download', format: data.format, revision, buffer: bytes.buffer, widthPx, heightPx }, [bytes.buffer]);
    }
  } catch (error) { scope.postMessage({ type: 'error', revision: 'revision' in data ? data.revision : revision, message: error instanceof Error ? error.message : String(error) }); }
};
