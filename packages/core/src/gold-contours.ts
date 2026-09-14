import { binarize, despeckle, simplifyPolyline } from './trace';
import { prepareTraceInput } from './input-preprocessing';
import type { Face, FaceColor, Geometry, RasterInput, TraceParams, TraceResult, Vec2 } from './types';

export interface GoldContourResult { trace: TraceResult; binary: Uint8Array }

export function goldFaceColors(faces: Face[], binary: Uint8Array, width: number, height: number, colorIndex: number): Record<string, FaceColor> {
  return Object.fromEntries(faces.map(face => {
    const x = Math.max(0, Math.min(width - 1, Math.floor(face.ref.x))), y = Math.max(0, Math.min(height - 1, Math.floor(face.ref.y)));
    return [face.id, { colorIndex: binary[y * width + x] ? colorIndex : 0, ref: face.ref }];
  }));
}

/** Trace the boundaries of filled gold ink. Centerline widths cannot represent
 * broad petals with fine dark engraving; closed contours preserve both sides.
 * Directed pixel boundaries keep corner-touching components separate. Only the
 * selected source mask is changed; the original raster remains untouched.
 */
export function traceGoldArtwork(input: RasterInput, overrides: Partial<TraceParams> = {}): GoldContourResult {
  const params: TraceParams = { threshold: 'otsu', invert: false, minSpeckArea: 4, gapClosePx: 0, spurPrunePx: 0, simplifyTolerance: 1, fitMaxError: 1.5, cornerAngleDeg: 60, ...overrides, inputMode: 'black-gold' };
  for (const key of ['minSpeckArea', 'simplifyTolerance', 'gapClosePx', 'spurPrunePx', 'fitMaxError', 'cornerAngleDeg'] as const) if (!Number.isFinite(params[key]) || params[key] < 0) throw new Error(`${key} must be finite and non-negative.`);
  if (params.fitMaxError === 0 || params.cornerAngleDeg > 180) throw new Error('Trace curve settings are out of range.');
  // Gold engraving contains meaningful small dark cuts. Cap despeckling and
  // simplification, and do not invent gap joins across a filled silhouette.
  params.minSpeckArea = Math.min(params.minSpeckArea, 4);
  params.simplifyTolerance = Math.min(params.simplifyTolerance, 1);
  params.gapClosePx = 0; params.spurPrunePx = 0;
  const thresholded = binarize(prepareTraceInput(input, 'black-gold'), params.threshold, params.invert);
  const binary = despeckle(thresholded.binary, input.width, input.height, params.minSpeckArea);
  const stride = input.width + 1, outgoing = new Uint8Array(stride * (input.height + 1));
  let boundaries = 0;
  const mark = (vertex: number, direction: number) => { outgoing[vertex] |= 1 << direction; boundaries++; };
  for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
    const pixel = y * input.width + x; if (!binary[pixel]) continue;
    const vertex = y * stride + x;
    if (y === 0 || !binary[pixel - input.width]) mark(vertex, 0);
    if (x === input.width - 1 || !binary[pixel + 1]) mark(vertex + 1, 1);
    if (y === input.height - 1 || !binary[pixel + input.width]) mark(vertex + stride + 1, 2);
    if (x === 0 || !binary[pixel - 1]) mark(vertex + stride, 3);
  }
  const geometry: Geometry = { nodes: {}, edges: {}, faceColors: {} }, objects: TraceResult['objects'] = [];
  const vertexIds = new Map<number, string>(), delta = [1, stride, -1, -stride];
  const nodeId = (point: Vec2): string => {
    const vertex = Math.round(point.y * 64) * (input.width * 64 + 1) + Math.round(point.x * 64), existing = vertexIds.get(vertex); if (existing) return existing;
    const id = `gn${vertexIds.size + 1}`; vertexIds.set(vertex, id); geometry.nodes[id] = { id, p: point, kind: 'corner' }; return id;
  };
  let totalLength = 0, edgeCount = 0;
  for (let start = 0; start < outgoing.length; start++) while (outgoing[start]) {
    let direction = 0; while (!(outgoing[start] & (1 << direction))) direction++;
    let vertex = start, previous = -1, steps = 0;
    const points: Vec2[] = [];
    do {
      if (direction !== previous) points.push({ x: vertex % stride, y: Math.floor(vertex / stride) });
      outgoing[vertex] &= ~(1 << direction); totalLength++; steps++;
      vertex += delta[direction]; previous = direction;
      if (vertex === start) break;
      const choices = [(direction + 1) % 4, direction, (direction + 3) % 4, (direction + 2) % 4];
      const next = choices.find(candidate => outgoing[vertex] & (1 << candidate));
      if (next === undefined || steps > boundaries) throw new Error('The gold contour could not be closed. Try a smaller source crop.');
      direction = next;
    } while (true);
    if (points.length < 3) continue;
    const closed = [...points, points[0]];
    const simplified = simplifyPolyline(closed, params.simplifyTolerance).map(index => closed[index]);
    const ring = simplified.length >= 4 ? simplified : closed;
    const nodeIds = ring.map(nodeId), segments = nodeIds.slice(1).map(() => ({}));
    const id = `gold${++edgeCount}`;
    geometry.edges[id] = { id, nodeIds, segments, width: 0, widthMode: 'design', strokeHidden: false, colorIndex: 1, z: 0 };
    objects.push({ id: `go${edgeCount}`, name: `Gold boundary ${edgeCount}`, edgeIds: [id], locked: false, hidden: false });
  }
  const warnings = [
    'Gold artwork is preserved as filled vector shapes, including dark cuts inside petals and leaves. Metallic shading becomes one gold palette color.',
    'Gold boundaries start with no added outline. Edit their nodes or fill colors; hiding a stroke keeps its fill. Set an outline width if you want a visible border.',
    `Gold boundary simplification is limited to ${params.simplifyTolerance} source pixel and speck cleanup to ${params.minSpeckArea} pixels.`,
  ];
  if (overrides.gapClosePx) warnings.push('Gap repair is not applied to filled gold artwork. Its source silhouettes remain separate.');
  if (!edgeCount) warnings.push('No gold artwork was found. Check the image colors and separation threshold.');
  return { binary, trace: { geometry, objects, params, report: { threshold: thresholded.threshold, lineWidthEstimate: 0, nodes: vertexIds.size, edges: edgeCount, objects: objects.length, faces: 0, openEnds: [], autoClosed: [], spursPruned: 0, nodesPer1000du: totalLength ? vertexIds.size * 1000 / totalLength : 0, warnings } } };
}
