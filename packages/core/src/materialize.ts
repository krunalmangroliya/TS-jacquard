import type { Master } from './types';
import { buildPlanarMap, resolveFaceColors, trackFaces } from './topology';

/** Reconcile persisted color references every time; content-derived face IDs can change after editing. */
export function materializeGeometry(master:Master) {
  const geometry={...master.geometry,edges:{...master.geometry.edges},faceColors:{...master.geometry.faceColors}};
  const original=buildPlanarMap(geometry,master.bounds,master.repeat);
  const resolved=resolveFaceColors(original.faces,geometry.faceColors);
  geometry.faceColors=resolved.faceColors;
  const warnings=[...original.warnings,...resolved.warnings];
  const hidden=master.objects.filter(o=>o.hidden).flatMap(o=>o.edgeIds);
  if(!hidden.length)return {geometry,faces:original.faces,warnings};
  for(const id of hidden)delete geometry.edges[id];
  const visible=buildPlanarMap(geometry,master.bounds,master.repeat);
  const tracked=trackFaces(original.faces,geometry.faceColors,visible.faces);
  geometry.faceColors=tracked.faceColors;
  warnings.push(...visible.warnings,...tracked.warnings,'Hidden objects were omitted from export');
  return {geometry,faces:tracked.faces,warnings};
}
