import type { Master, Vec2, Palette, FaceColor, Edge, Node, Face, BezierSegment, DesignObject } from './types';
import { buildPlanarMap, faceAt, resolveFaceColors, trackFaces } from './topology';
import { geometrySchema, paletteSchema, validateMaster } from './schemas';
import { z } from 'zod';

/** Serializable deterministic edits shared by the CLI and interactive worker. */
export type Operation =
  | { t:'setFaceColor'; faceId:string; ref:Vec2; colorIndex:number|null }
  | { t:'moveNodes'; nodes:{id:string;to:Vec2}[] }
  | { t:'transformObjects'; objectIds:string[]; matrix:[number,number,number,number,number,number] }
  | { t:'setEdgeStyle'; edgeId:string; width:number; widthMode?:'output'|'design'; colorIndex?:number }
  | { t:'setStrokeVisibility'; edgeIds:string[]; hidden:boolean }
  | { t:'deleteEdge'; edgeId:string }
  | { t:'setPalette'; palette:Palette }
  | { t:'setObjectFlags'; objectId:string; locked:boolean; hidden:boolean }
  | { t:'addEdge'; edge:Edge; nodes:Node[]; objectId:string; objectName?:string }
  | { t:'setNodeKind'; nodeId:string; kind:Node['kind'] }
  | { t:'setControls'; edgeId:string; segIndex:number; c1?:Vec2; c2?:Vec2 }
  | { t:'insertNode'; edgeId:string; segIndex:number; tParam:number; nodeId:string }
  | { t:'deleteNode'; edgeId:string; nodeId:string }
  | { t:'group'; objectIds:string[]; resultId:string; name?:string }
  | { t:'ungroup'; objectId:string }
  | { t:'duplicateObjects'; objectIds:string[]; offset:Vec2; idPrefix:string }
  | { t:'deleteObjects'; objectIds:string[] }
  | { t:'renameObject'; objectId:string; name:string }
  | { t:'mergePalette'; sourceIndex:number; targetIndex:number };
export interface OperationCache {
  faces?:Face[]; assumeValidated?:boolean;
  /** Defer supported geometry edits. Reconcile faces before fill/export; other operations settle immediately. */
  deferTopology?:boolean;
}
export interface OperationResult { master:Master; warnings:string[]; faces?:Face[]; geometryChanged:boolean }
const operationId=z.string().min(1).max(1000),operationPoint=z.object({x:z.number().finite(),y:z.number().finite()}),operationColor=z.number().int().min(0).max(5);
const operationIds=z.array(operationId).min(1).max(100000);
export const operationSchema=z.discriminatedUnion('t',[
  z.object({t:z.literal('setFaceColor'),faceId:operationId,ref:operationPoint,colorIndex:operationColor.nullable()}),
  z.object({t:z.literal('moveNodes'),nodes:z.array(z.object({id:operationId,to:operationPoint})).min(1).max(100000)}),
  z.object({t:z.literal('transformObjects'),objectIds:operationIds,matrix:z.tuple([z.number().finite(),z.number().finite(),z.number().finite(),z.number().finite(),z.number().finite(),z.number().finite()])}),
  z.object({t:z.literal('setEdgeStyle'),edgeId:operationId,width:z.number().finite().min(0).max(8192),widthMode:z.enum(['output','design']).optional(),colorIndex:operationColor.optional()}),
  z.object({t:z.literal('setStrokeVisibility'),edgeIds:operationIds,hidden:z.boolean()}),
  z.object({t:z.literal('deleteEdge'),edgeId:operationId}),
  z.object({t:z.literal('setPalette'),palette:paletteSchema}),
  z.object({t:z.literal('setObjectFlags'),objectId:operationId,locked:z.boolean(),hidden:z.boolean()}),
  z.object({t:z.literal('addEdge'),edge:geometrySchema.shape.edges.valueSchema,nodes:z.array(geometrySchema.shape.nodes.valueSchema).max(100000),objectId:operationId,objectName:z.string().optional()}),
  z.object({t:z.literal('setNodeKind'),nodeId:operationId,kind:z.enum(['corner','smooth'])}),
  z.object({t:z.literal('setControls'),edgeId:operationId,segIndex:z.number().int().min(0),c1:operationPoint.optional(),c2:operationPoint.optional()}),
  z.object({t:z.literal('insertNode'),edgeId:operationId,segIndex:z.number().int().min(0),tParam:z.number().finite().gt(0).lt(1),nodeId:operationId}),
  z.object({t:z.literal('deleteNode'),edgeId:operationId,nodeId:operationId}),
  z.object({t:z.literal('group'),objectIds:operationIds,resultId:operationId,name:z.string().optional()}),
  z.object({t:z.literal('ungroup'),objectId:operationId}),
  z.object({t:z.literal('duplicateObjects'),objectIds:operationIds,offset:operationPoint,idPrefix:operationId}),
  z.object({t:z.literal('deleteObjects'),objectIds:operationIds}),
  z.object({t:z.literal('renameObject'),objectId:operationId,name:z.string().min(1)}),
  z.object({t:z.literal('mergePalette'),sourceIndex:operationColor.min(1),targetIndex:operationColor}),
]);
export function validateOperation(value:unknown):Operation{return operationSchema.parse(value) as Operation;}
export interface HistoryEntry { operation:Operation; before:Master; after:Master; warnings:string[] }
export interface EditHistory { current:Master; past:HistoryEntry[]; future:HistoryEntry[] }
const clone = <T>(value:T):T => JSON.parse(JSON.stringify(value)) as T;
const snap = (p:Vec2):Vec2 => {
  if(!Number.isFinite(p.x)||!Number.isFinite(p.y))throw new Error('Point coordinates must be finite');
  const x=Math.round(p.x*64),y=Math.round(p.y*64);
  if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y))throw new Error('Point exceeds the supported fixed-point coordinate range');
  return {x:x/64,y:y/64};
};
const snapWidth=(width:number)=>Math.round(width*64)/64;
const mix=(a:Vec2,b:Vec2,t:number):Vec2=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const compareId=(a:string,b:string)=>a<b?-1:a>b?1:0;
function edgeUnlocked(master:Master,id:string):Edge {
  const edge=master.geometry.edges[id];if(!edge)throw new Error(`Missing edge ${id}`);
  if(master.objects.some(o=>o.locked&&o.edgeIds.includes(id)))throw new Error('The edge belongs to a locked object');
  return edge;
}
function nodeUnlocked(master:Master,id:string):Node {
  const node=master.geometry.nodes[id];if(!node)throw new Error(`Missing node ${id}`);
  if(master.objects.some(o=>o.locked&&o.edgeIds.some(e=>master.geometry.edges[e].nodeIds.includes(id))))throw new Error('The node belongs to a locked object');
  return node;
}
function selectedObjects(master:Master,ids:string[]):DesignObject[] {
  if(!Array.isArray(ids)||!ids.length)throw new Error('Select at least one object');
  return [...new Set(ids)].map(id=>{const object=master.objects.find(o=>o.id===id);if(!object)throw new Error(`Missing object ${id}`);if(object.locked)throw new Error(`Object ${id} is locked`);return object;});
}
function removeUnusedNodes(master:Master):void {
  const used=new Set(Object.values(master.geometry.edges).flatMap(edge=>edge.nodeIds));
  for(const id of Object.keys(master.geometry.nodes))if(!used.has(id))delete master.geometry.nodes[id];
}
function removeEdges(master:Master,ids:Set<string>):void {
  for(const id of ids)delete master.geometry.edges[id];
  master.objects=master.objects.map(object=>({...object,edgeIds:object.edgeIds.filter(id=>!ids.has(id))})).filter(object=>object.edgeIds.length);
  removeUnusedNodes(master);
}
function colorValid(master:Master,color:number|null):void {
  if(color!==null&&(!Number.isInteger(color)||color<0||color>=master.palette.entries.length))throw new Error('Color is outside the palette');
}
function faceUnlocked(master:Master,face:Face):void {
  if(!face.outer)return;
  const key=(p:Vec2)=>`${Math.round(p.x*64)},${Math.round(p.y*64)}`;
  const boundary=new Set([face.outer,...face.holes].flatMap(ring=>ring.map(key)));
  if(master.objects.some(object=>object.locked&&object.edgeIds.some(id=>master.geometry.edges[id].nodeIds.some(n=>boundary.has(key(master.geometry.nodes[n].p))))))throw new Error('The face touches a locked object');
}
function alignedOppositeHandles(master:Master,nodeId:string,moved:Vec2,skip:{edgeId:string;segment:number;key:'c1'|'c2'},incidentEdges?:Edge[]):void {
  const node=master.geometry.nodes[nodeId];if(node.kind!=='smooth')return;
  const dx=moved.x-node.p.x,dy=moved.y-node.p.y,length=Math.hypot(dx,dy);if(!length)return;
  for(const edge of incidentEdges??Object.values(master.geometry.edges))for(let i=0;i<edge.segments.length;i++)for(const [id,key] of [[edge.nodeIds[i],'c1'],[edge.nodeIds[i+1],'c2']] as const){
    if(id!==nodeId||(edge.id===skip.edgeId&&i===skip.segment&&key===skip.key))continue;
    const handle=edge.segments[i][key];if(!handle)continue;
    const radius=Math.hypot(handle.x-node.p.x,handle.y-node.p.y);
    edge.segments[i][key]=snap({x:node.p.x-dx/length*radius,y:node.p.y-dy/length*radius});
  }
}

/** Geometry operations that can commit independently of face reconstruction. */
export const DEFERRED_GEOMETRY_OPERATIONS:readonly Operation['t'][]=['moveNodes','setControls','setNodeKind','insertNode','deleteNode','addEdge','deleteEdge','deleteObjects'];
const deferredGeometryOperations=new Set(DEFERRED_GEOMETRY_OPERATIONS);
/** Copy only mutation targets. Unchanged anchors, edges, objects and fill assignments remain shared. */
function copyGeometryEdit(input:Master,operation:Operation):{master:Master;edgeIds:Set<string>} {
  const nodeIds=new Set<string>(),edgeIds=new Set<string>();
  if(operation.t==='moveNodes')for(const move of operation.nodes)nodeIds.add(move.id);
  else if(operation.t==='setNodeKind')nodeIds.add(operation.nodeId);
  else if(operation.t==='setControls'){
    edgeIds.add(operation.edgeId);const edge=input.geometry.edges[operation.edgeId];
    if(edge)for(const id of [edge.nodeIds[operation.segIndex],edge.nodeIds[operation.segIndex+1]])if(input.geometry.nodes[id]?.kind==='smooth')nodeIds.add(id);
  }else if(operation.t==='insertNode'||operation.t==='deleteNode'||operation.t==='deleteEdge')edgeIds.add(operation.edgeId);
  else if(operation.t==='addEdge')edgeIds.add(operation.edge.id);
  else if(operation.t==='deleteObjects'){const ids=new Set(operation.objectIds);for(const object of input.objects)if(ids.has(object.id))for(const id of object.edgeIds)edgeIds.add(id);}
  if(nodeIds.size)for(const edge of Object.values(input.geometry.edges))if(edge.nodeIds.some(id=>nodeIds.has(id)))edgeIds.add(edge.id);
  const nodes=operation.t==='setControls'?input.geometry.nodes:{...input.geometry.nodes},edges={...input.geometry.edges};
  if(nodes!==input.geometry.nodes)for(const id of nodeIds)if(nodes[id])nodes[id]={...nodes[id]};
  for(const id of edgeIds)if(edges[id]){const edge=edges[id];edges[id]={...edge,nodeIds:operation.t==='insertNode'||operation.t==='deleteNode'?[...edge.nodeIds]:edge.nodeIds,segments:edge.segments.map(segment=>({...segment}))};}
  const objects=operation.t==='addEdge'?input.objects.map(object=>object.id===operation.objectId?{...object,edgeIds:[...object.edgeIds]}:object):input.objects;
  return {master:{...input,objects,geometry:{...input.geometry,nodes,edges}},edgeIds};
}

/** Targeted immutable updates used when the worker already validated the master and cached its faces. */
function cachedAppearanceOperation(master:Master,operation:Operation,faces:Face[]|undefined):Master|undefined {
  if(operation.t==='mergePalette'){
    const source=operation.sourceIndex,target=operation.targetIndex;
    colorValid(master,source);colorValid(master,target);if(source===0||source===target)throw new Error('Merge a non-ground color into a different color');
    const remap=(index:number)=>{const replaced=index===source?target:index;return replaced>source?replaced-1:replaced;};
    const palette={entries:master.palette.entries.filter(entry=>entry.index!==source).map(entry=>({...entry,index:remap(entry.index)}))};
    const edges=Object.fromEntries(Object.entries(master.geometry.edges).map(([id,edge])=>[id,edge.colorIndex===undefined?edge:{...edge,colorIndex:remap(edge.colorIndex)}]));
    const faceColors=Object.fromEntries(Object.entries(master.geometry.faceColors).map(([id,color])=>[id,color.colorIndex===null?color:{...color,colorIndex:remap(color.colorIndex)}]));
    return {...master,palette,geometry:{...master.geometry,edges,faceColors}};
  }
  if(operation.t==='setStrokeVisibility')return setStrokeVisibility(master,operation.edgeIds,operation.hidden);
  if(operation.t==='setFaceColor'&&faces){
    colorValid(master,operation.colorIndex);
    const face=faces.find(f=>f.id===operation.faceId)??faceAt(faces,operation.ref);if(!face)throw new Error('The selected face no longer exists');
    faceUnlocked(master,face);
    const faceColors={...master.geometry.faceColors};
    for(const member of faces)if(member.id===face.id||(face.seamGroup&&member.seamGroup===face.seamGroup))faceColors[member.id]={colorIndex:operation.colorIndex,ref:member.ref};
    return {...master,geometry:{...master.geometry,faceColors}};
  }
  if(operation.t==='setEdgeStyle'){
    const edge={...edgeUnlocked(master,operation.edgeId),width:operation.width};
    if(operation.widthMode!==undefined)edge.widthMode=operation.widthMode;
    if(operation.colorIndex!==undefined)edge.colorIndex=operation.colorIndex;
    if(!Number.isFinite(edge.width)||edge.width<0||edge.width>(edge.widthMode==='design'?8192:8))throw new Error('Invalid stroke width');
    if(edge.widthMode!==undefined&&!['design','output'].includes(edge.widthMode))throw new Error('Invalid stroke width mode');
    if(edge.width>0&&edge.colorIndex===undefined)throw new Error('Visible strokes need a color');
    if(edge.colorIndex!==undefined)colorValid(master,edge.colorIndex);
    return {...master,geometry:{...master.geometry,edges:{...master.geometry.edges,[edge.id]:edge}}};
  }
  if(operation.t==='setPalette'){
    const palette=paletteSchema.parse(operation.palette),next={...master,palette};
    if(palette.entries.some((entry,i)=>entry.index!==i))throw new Error('Palette indices must be contiguous');
    for(const edge of Object.values(master.geometry.edges))if(edge.colorIndex!==undefined)colorValid(next,edge.colorIndex);
    for(const color of Object.values(master.geometry.faceColors))colorValid(next,color.colorIndex);
    return next;
  }
  if(operation.t==='setObjectFlags'){
    const object=master.objects.find(o=>o.id===operation.objectId);if(!object)throw new Error('Missing object');
    if(typeof operation.locked!=='boolean'||typeof operation.hidden!=='boolean')throw new Error('Object flags must be boolean');
    if(object.locked&&operation.hidden!==object.hidden)throw new Error('Unlock the object before changing its visibility');
    return {...master,objects:master.objects.map(o=>o.id===object.id?{...o,locked:operation.locked,hidden:operation.hidden}:o)};
  }
  if(operation.t==='renameObject'){
    selectedObjects(master,[operation.objectId]);if(typeof operation.name!=='string'||!operation.name.trim())throw new Error('Object name is required');
    return {...master,objects:master.objects.map(o=>o.id===operation.objectId?{...o,name:operation.name}:o)};
  }
  return undefined;
}

/** For a previously validated master. Shares unchanged geometry; safe for worker delta history. */
export function setStrokeVisibility(master:Master, edgeIds:string[], hidden:boolean):Master {
  if (typeof hidden !== 'boolean' || !Array.isArray(edgeIds) || edgeIds.some(id => typeof id !== 'string')) throw new Error('Stroke visibility requires edge IDs and a boolean hidden value');
  const selected = new Set(edgeIds);
  for (const id of selected) if (!master.geometry.edges[id]) throw new Error(`Missing edge ${id}`);
  if (master.objects.some(o => o.locked && o.edgeIds.some(id => selected.has(id)))) throw new Error('A selected stroke belongs to a locked object');
  const edges = {...master.geometry.edges};
  for (const id of selected) edges[id] = {...edges[id], strokeHidden:hidden};
  return {...master, geometry:{...master.geometry, edges}};
}

export function applyOperation(input:Master, operation:Operation, cache:OperationCache={}):OperationResult {
  if(cache.assumeValidated){const updated=cachedAppearanceOperation(input,operation,cache.faces);if(updated)return {master:updated,warnings:[],faces:cache.faces,geometryChanged:false};}
  const deferred=!!cache.deferTopology&&deferredGeometryOperations.has(operation.t);
  // A deferred edit still validates its operation payload; the caller must opt in to a previously validated master.
  const targeted=!!cache.assumeValidated&&deferredGeometryOperations.has(operation.t);
  if(deferred||targeted)operation=validateOperation(operation);
  const copy=targeted?copyGeometryEdit(input,operation):undefined;
  const master=copy?.master??validateMaster(input),warnings:string[]=[],incidentEdges=copy?[...copy.edgeIds].map(id=>master.geometry.edges[id]).filter(Boolean):undefined;
  if(operation.t==='mergePalette')return {master:validateMaster(cachedAppearanceOperation(master,operation,cache.faces)!),warnings,faces:cache.faces,geometryChanged:false};
  if(operation.t==='setStrokeVisibility')return {master:setStrokeVisibility(master,operation.edgeIds,operation.hidden),warnings,faces:cache.faces,geometryChanged:false};
  const needsTopology=['setFaceColor','moveNodes','transformObjects','deleteEdge','addEdge','setNodeKind','setControls','insertNode','deleteNode','duplicateObjects','deleteObjects'].includes(operation.t);
  const oldFaces=needsTopology&&!deferred?(cache.faces??buildPlanarMap(master.geometry,master.bounds,master.repeat).faces):[];
  if(needsTopology&&!deferred){const persisted=resolveFaceColors(oldFaces,master.geometry.faceColors);master.geometry.faceColors=persisted.faceColors;warnings.push(...persisted.warnings);}
  const transformedColors:{ref:Vec2;color:FaceColor}[]=[];
  let geometryChanged=false;
  switch(operation.t) {
    case 'setFaceColor': {
      const face=oldFaces.find(f=>f.id===operation.faceId)??faceAt(oldFaces,operation.ref);
      if(!face)throw new Error('The selected face no longer exists');
      colorValid(master,operation.colorIndex);faceUnlocked(master,face);
      for(const member of oldFaces.filter(f=>f.id===face.id||(face.seamGroup&&f.seamGroup===face.seamGroup))) master.geometry.faceColors[member.id]={colorIndex:operation.colorIndex,ref:member.ref};
      break;
    }
    case 'moveNodes': {
      const nodes=new Set(operation.nodes.map(n=>n.id));
      if(master.objects.some(o=>o.locked&&o.edgeIds.some(id=>master.geometry.edges[id].nodeIds.some(n=>nodes.has(n)))))throw new Error('A selected node belongs to a locked object');
      for(const move of operation.nodes) {
        const node=master.geometry.nodes[move.id];if(!node)throw new Error(`Missing node ${move.id}`);
        const target=snap(move.to),delta={x:target.x-node.p.x,y:target.y-node.p.y};
        for(const edge of incidentEdges??Object.values(master.geometry.edges))for(let i=0;i<edge.segments.length;i++) {
          const segment=edge.segments[i];
          if(edge.nodeIds[i]===move.id&&segment.c1)segment.c1=snap({x:segment.c1.x+delta.x,y:segment.c1.y+delta.y});
          if(edge.nodeIds[i+1]===move.id&&segment.c2)segment.c2=snap({x:segment.c2.x+delta.x,y:segment.c2.y+delta.y});
        }
        node.p=target;
      }
      geometryChanged=true;break;
    }
    case 'transformObjects': {
      const [a,b,c,d,e,f]=operation.matrix;
      if(!operation.matrix.every(Number.isFinite)||Math.abs(a*d-b*c)<1e-12)throw new Error('Transform must be finite and invertible');
      const transform=(p:Vec2)=>snap({x:a*p.x+c*p.y+e,y:b*p.x+d*p.y+f});
      const objects=operation.objectIds.map(id=>{const o=master.objects.find(o=>o.id===id);if(!o)throw new Error(`Missing object ${id}`);if(o.locked)throw new Error(`Object ${id} is locked`);return o;});
      const edgeIds=new Set(objects.flatMap(o=>o.edgeIds)),nodeIds=new Set([...edgeIds].flatMap(id=>master.geometry.edges[id].nodeIds));
      const sx=Math.hypot(a,b),sy=Math.hypot(c,d),uniform=Math.abs(sx-sy)<=1e-9*Math.max(sx,sy)&&Math.abs(a*c+b*d)<=1e-9*sx*sy;
      for(const id of edgeIds){const edge=master.geometry.edges[id];if(edge.widthMode==='design')edge.width=snapWidth(edge.width*(uniform?sx:Math.sqrt(Math.abs(a*d-b*c))));}
      if(!uniform&&[...edgeIds].some(id=>master.geometry.edges[id].widthMode==='design'))warnings.push('Nonuniform transformation approximates design stroke widths with an area-preserving scale; inspect the transformed strokes');
      if(master.objects.some(o=>o.locked&&o.edgeIds.some(id=>master.geometry.edges[id].nodeIds.some(n=>nodeIds.has(n)))))throw new Error('A shared node belongs to a locked adjoining object');
      const objectGeometry={...master.geometry,edges:Object.fromEntries([...edgeIds].map(id=>[id,master.geometry.edges[id]]))};
      const objectFaces=buildPlanarMap(objectGeometry,master.bounds,master.repeat).faces;
      for(const face of oldFaces) {
        const owner=faceAt(objectFaces,face.ref),color=master.geometry.faceColors[face.id];
        if(owner&&owner.outer!==null&&owner.seamGroup!=='ground'&&color)transformedColors.push({ref:transform(face.ref),color});
      }
      for(const edge of Object.values(master.geometry.edges)) {
        if(edgeIds.has(edge.id))for(const segment of edge.segments){if(segment.c1)segment.c1=transform(segment.c1);if(segment.c2)segment.c2=transform(segment.c2);}
        else for(let i=0;i<edge.segments.length;i++){
          const segment=edge.segments[i];
          for(const [nodeId,key] of [[edge.nodeIds[i],'c1'],[edge.nodeIds[i+1],'c2']] as const)if(nodeIds.has(nodeId)&&segment[key]){
            const old=master.geometry.nodes[nodeId].p,next=transform(old),p=segment[key]!;segment[key]=snap({x:p.x+next.x-old.x,y:p.y+next.y-old.y});warnings.push('A shared node moved an adjoining object edge');
          }
        }
      }
      for(const id of nodeIds)master.geometry.nodes[id].p=transform(master.geometry.nodes[id].p);
      geometryChanged=true;break;
    }
    case 'setEdgeStyle': {
      const edge=master.geometry.edges[operation.edgeId];if(!edge)throw new Error('Missing edge');
      if(master.objects.some(o=>o.locked&&o.edgeIds.includes(edge.id)))throw new Error('The edge belongs to a locked object');
      edge.width=operation.width;
      if(operation.colorIndex!==undefined)edge.colorIndex=operation.colorIndex;
      if(operation.widthMode!==undefined)edge.widthMode=operation.widthMode;
      break;
    }
    case 'deleteEdge': {
      if(!master.geometry.edges[operation.edgeId])throw new Error('Missing edge');
      if(master.objects.some(o=>o.locked&&o.edgeIds.includes(operation.edgeId)))throw new Error('The edge belongs to a locked object');
      delete master.geometry.edges[operation.edgeId];
      master.objects=master.objects.map(o=>({...o,edgeIds:o.edgeIds.filter(id=>id!==operation.edgeId)})).filter(o=>o.edgeIds.length);
      const used=new Set(Object.values(master.geometry.edges).flatMap(e=>e.nodeIds));for(const id of Object.keys(master.geometry.nodes))if(!used.has(id))delete master.geometry.nodes[id];
      geometryChanged=true;break;
    }
    case 'addEdge': {
      if(master.geometry.edges[operation.edge.id])throw new Error('The new edge ID already exists');
      if(operation.edge.widthMode!=='design'&&operation.edge.width>8)throw new Error('Output-pixel edge width exceeds 8');
      if(operation.edge.width>0&&operation.edge.colorIndex===undefined)throw new Error('Styled edge has no valid color');
      if(operation.edge.colorIndex!==undefined)colorValid(master,operation.edge.colorIndex);
      let object=master.objects.find(o=>o.id===operation.objectId);if(object?.locked)throw new Error('The target object is locked');
      const supplied=new Set<string>();
      for(const node of operation.nodes){if(master.geometry.nodes[node.id]||supplied.has(node.id))throw new Error(`New node ID already exists: ${node.id}`);if(!operation.edge.nodeIds.includes(node.id))throw new Error('A supplied node is not used by the new edge');supplied.add(node.id);}
      for(const id of operation.edge.nodeIds)if(!supplied.has(id))nodeUnlocked(master,id);
      for(const node of operation.nodes)master.geometry.nodes[node.id]={...clone(node),p:snap(node.p)};
      const edge=clone(operation.edge);for(const segment of edge.segments){if(segment.c1)segment.c1=snap(segment.c1);if(segment.c2)segment.c2=snap(segment.c2);}master.geometry.edges[edge.id]=edge;
      if(!object){object={id:operation.objectId,name:operation.objectName??'New object',edgeIds:[],locked:false,hidden:false};master.objects.push(object);}object.edgeIds.push(edge.id);
      geometryChanged=true;break;
    }
    case 'setNodeKind': {
      const node=nodeUnlocked(master,operation.nodeId);if(!['corner','smooth'].includes(operation.kind))throw new Error('Invalid node kind');
      const attached:{edge:Edge;index:number;key:'c1'|'c2'}[]=[];
      for(const edge of incidentEdges??Object.values(master.geometry.edges))for(let i=0;i<edge.segments.length;i++){if(edge.nodeIds[i]===node.id)attached.push({edge,index:i,key:'c1'});if(edge.nodeIds[i+1]===node.id)attached.push({edge,index:i,key:'c2'});}
      if(operation.kind==='smooth'&&attached.length>2)throw new Error('A junction with more than two incident segments cannot be smooth');
      node.kind=operation.kind;
      const handle=attached.find(a=>a.edge.segments[a.index][a.key]);
      if(handle&&node.kind==='smooth')alignedOppositeHandles(master,node.id,handle.edge.segments[handle.index][handle.key]!,{edgeId:handle.edge.id,segment:handle.index,key:handle.key},incidentEdges);
      geometryChanged=true;break;
    }
    case 'setControls': {
      const edge=edgeUnlocked(master,operation.edgeId),i=operation.segIndex;if(!Number.isInteger(i)||i<0||i>=edge.segments.length)throw new Error('Invalid segment index');
      nodeUnlocked(master,edge.nodeIds[i]);nodeUnlocked(master,edge.nodeIds[i+1]);
      const segment:BezierSegment={};if(operation.c1)segment.c1=snap(operation.c1);if(operation.c2)segment.c2=snap(operation.c2);edge.segments[i]=segment;
      if(segment.c1)alignedOppositeHandles(master,edge.nodeIds[i],segment.c1,{edgeId:edge.id,segment:i,key:'c1'},incidentEdges);
      if(segment.c2)alignedOppositeHandles(master,edge.nodeIds[i+1],segment.c2,{edgeId:edge.id,segment:i,key:'c2'},incidentEdges);
      geometryChanged=true;break;
    }
    case 'insertNode': {
      const edge=edgeUnlocked(master,operation.edgeId),i=operation.segIndex,t=operation.tParam;
      if(!Number.isInteger(i)||i<0||i>=edge.segments.length||!Number.isFinite(t)||t<=0||t>=1)throw new Error('Insertion needs a valid segment and tParam strictly between 0 and 1');
      if(master.geometry.nodes[operation.nodeId])throw new Error('The inserted node ID already exists');
      const a=master.geometry.nodes[edge.nodeIds[i]].p,d=master.geometry.nodes[edge.nodeIds[i+1]].p,segment=edge.segments[i];
      let anchor:Vec2,left:BezierSegment={},right:BezierSegment={};
      if(!segment.c1&&!segment.c2)anchor=mix(a,d,t);
      else {const ab=mix(a,segment.c1??a,t),bc=mix(segment.c1??a,segment.c2??d,t),cd=mix(segment.c2??d,d,t),abc=mix(ab,bc,t),bcd=mix(bc,cd,t);anchor=mix(abc,bcd,t);left={c1:snap(ab),c2:snap(abc)};right={c1:snap(bcd),c2:snap(cd)};}
      master.geometry.nodes[operation.nodeId]={id:operation.nodeId,p:snap(anchor),kind:segment.c1||segment.c2?'smooth':'corner'};
      edge.nodeIds.splice(i+1,0,operation.nodeId);edge.segments.splice(i,1,left,right);geometryChanged=true;break;
    }
    case 'deleteNode': {
      const edge=edgeUnlocked(master,operation.edgeId);nodeUnlocked(master,operation.nodeId);
      const closed=edge.nodeIds[0]===edge.nodeIds.at(-1),indices=edge.nodeIds.flatMap((id,i)=>id===operation.nodeId?[i]:[]);
      if(!indices.length)throw new Error('The edge does not contain that node');
      if(indices.length>1&&!(closed&&indices.length===2&&indices[0]===0&&indices[1]===edge.nodeIds.length-1))throw new Error('The node occurs more than once in this edge');
      const i=indices[0],merge=(left:BezierSegment,right:BezierSegment):BezierSegment=>({...left.c1?{c1:clone(left.c1)}:{},...right.c2?{c2:clone(right.c2)}:{}});
      if(edge.nodeIds.length<=2||(closed&&edge.nodeIds.length<=3)){removeEdges(master,new Set([edge.id]));}
      else if(closed&&i===0){const joined=merge(edge.segments.at(-1)!,edge.segments[0]);edge.nodeIds=edge.nodeIds.slice(1,-1);edge.nodeIds.push(edge.nodeIds[0]);edge.segments=[...edge.segments.slice(1,-1),joined];}
      else if(i===0){edge.nodeIds.shift();edge.segments.shift();}
      else if(i===edge.nodeIds.length-1){edge.nodeIds.pop();edge.segments.pop();}
      else {edge.segments.splice(i-1,2,merge(edge.segments[i-1],edge.segments[i]));edge.nodeIds.splice(i,1);}
      removeUnusedNodes(master);warnings.push('Deleting a node joins its neighbors while preserving outer handles; the removed curve section is approximated');geometryChanged=true;break;
    }
    case 'group': {
      const objects=selectedObjects(master,operation.objectIds),ids=new Set(objects.map(o=>o.id));
      if(master.objects.some(o=>o.id===operation.resultId&&!ids.has(o.id)))throw new Error('The group ID already exists');
      if(!operation.resultId)throw new Error('Group ID is required');
      const grouped:DesignObject={id:operation.resultId,name:operation.name??'Group',edgeIds:objects.flatMap(o=>o.edgeIds),locked:false,hidden:objects.every(o=>o.hidden)};
      const first=Math.min(...objects.map(o=>master.objects.indexOf(o)));master.objects=master.objects.filter(o=>!ids.has(o.id));master.objects.splice(first,0,grouped);break;
    }
    case 'ungroup': {
      const object=selectedObjects(master,[operation.objectId])[0],byNode=new Map<string,string[]>();
      for(const id of object.edgeIds)for(const n of master.geometry.edges[id].nodeIds){const edges=byNode.get(n)??[];edges.push(id);byNode.set(n,edges);}
      const seen=new Set<string>(),parts:string[][]=[];
      for(const id of object.edgeIds){if(seen.has(id))continue;const component=[id];seen.add(id);for(let i=0;i<component.length;i++)for(const n of master.geometry.edges[component[i]].nodeIds)for(const neighbor of byNode.get(n)!)if(!seen.has(neighbor)){seen.add(neighbor);component.push(neighbor);}parts.push(component);}
      const ids=new Set(master.objects.map(o=>o.id));
      const objects=parts.map((edgeIds,i)=>{let id=i===0?object.id:`${object.id}-part-${i+1}`;while(i>0&&ids.has(id))id+='-next';ids.add(id);return {...object,id,name:parts.length>1?`${object.name} ${i+1}`:object.name,edgeIds};});
      master.objects.splice(master.objects.indexOf(object),1,...objects);break;
    }
    case 'duplicateObjects': {
      const objects=selectedObjects(master,operation.objectIds),offset=snap(operation.offset);if(!operation.idPrefix)throw new Error('Duplicate ID prefix is required');
      const selectedEdges=new Set(objects.flatMap(o=>o.edgeIds)),selectedNodes=new Set([...selectedEdges].flatMap(id=>master.geometry.edges[id].nodeIds));
      const translated=(p:Vec2)=>snap({x:p.x+offset.x,y:p.y+offset.y});
      const selectedGeometry={...master.geometry,edges:Object.fromEntries([...selectedEdges].map(id=>[id,master.geometry.edges[id]]))};
      const selectedFaces=buildPlanarMap(selectedGeometry,master.bounds,master.repeat).faces;
      for(const face of oldFaces){const owner=faceAt(selectedFaces,face.ref),color=master.geometry.faceColors[face.id];if(owner?.outer&&owner.seamGroup!=='ground'&&color)transformedColors.push({ref:translated(face.ref),color});}
      const nodeIds=new Map([...selectedNodes].map(id=>[id,`${operation.idPrefix}-node-${id}`]));
      for(const [id,next] of nodeIds){if(master.geometry.nodes[next])throw new Error('Duplicate node ID collision');master.geometry.nodes[next]={...clone(master.geometry.nodes[id]),id:next,p:translated(master.geometry.nodes[id].p)};}
      for(const object of objects){const id=`${operation.idPrefix}-object-${object.id}`;if(master.objects.some(o=>o.id===id))throw new Error('Duplicate object ID collision');const edgeIds:string[]=[];
        for(const old of object.edgeIds){const edge=clone(master.geometry.edges[old]),next=`${operation.idPrefix}-edge-${old}`;if(master.geometry.edges[next])throw new Error('Duplicate edge ID collision');edge.id=next;edge.nodeIds=edge.nodeIds.map(n=>nodeIds.get(n)!);for(const segment of edge.segments){if(segment.c1)segment.c1=translated(segment.c1);if(segment.c2)segment.c2=translated(segment.c2);}master.geometry.edges[next]=edge;edgeIds.push(next);}
        master.objects.push({...clone(object),id,name:`${object.name} copy`,edgeIds});
      }
      geometryChanged=true;break;
    }
    case 'deleteObjects': {const objects=selectedObjects(master,operation.objectIds);removeEdges(master,new Set(objects.flatMap(o=>o.edgeIds)));geometryChanged=true;break;}
    case 'renameObject': {const object=selectedObjects(master,[operation.objectId])[0];if(typeof operation.name!=='string'||!operation.name.trim())throw new Error('Object name is required');object.name=operation.name;break;}
    case 'setPalette': master.palette=clone(operation.palette);break;
    case 'setObjectFlags': {const object=master.objects.find(o=>o.id===operation.objectId);if(!object)throw new Error('Missing object');if(object.locked&&operation.hidden!==object.hidden)throw new Error('Unlock the object before changing its visibility');object.locked=operation.locked;object.hidden=operation.hidden;break;}
    default: throw new Error('Unsupported edit operation');
  }
  let resultingFaces=cache.faces;
  if((deferred||copy)&&geometryChanged){
    for(const id of copy?.edgeIds??Object.keys(master.geometry.edges)){const edge=master.geometry.edges[id];if(!edge||edge===input.geometry.edges[id])continue;
      if(edge.segments.length!==edge.nodeIds.length-1||edge.nodeIds.some((n,i)=>!master.geometry.nodes[n]||(i>0&&n===edge.nodeIds[i-1])))throw new Error(`Invalid edge chain: ${id}`);
    }
    if(deferred)return {master,warnings:[...new Set(warnings)],faces:undefined,geometryChanged:true};
  }
  if(geometryChanged){
    const topology=buildPlanarMap(master.geometry,master.bounds,master.repeat),tracked=trackFaces(oldFaces,master.geometry.faceColors,topology.faces);
    master.geometry.faceColors=tracked.faceColors;warnings.push(...topology.warnings,...tracked.warnings);
    resultingFaces=tracked.faces;
    for(const entry of transformedColors){
      const ref=master.repeat.type==='none'?entry.ref:{x:((entry.ref.x%master.bounds.w)+master.bounds.w)%master.bounds.w,y:((entry.ref.y%master.bounds.h)+master.bounds.h)%master.bounds.h};
      const face=faceAt(tracked.faces,ref);
      if(face&&face.outer!==null&&face.seamGroup!=='ground')for(const member of tracked.faces.filter(f=>f.id===face.id||(face.seamGroup&&f.seamGroup===face.seamGroup)))master.geometry.faceColors[member.id]={colorIndex:entry.color.colorIndex,ref:member.ref};
      else warnings.push('A moved face could not retain its color; review the transformed motif');
    }
  }
  return {master:copy?master:validateMaster(master),warnings:[...new Set(warnings)],faces:resultingFaces??(needsTopology?oldFaces:undefined),geometryChanged};
}
export function createHistory(master:Master):EditHistory{return {current:validateMaster(clone(master)),past:[],future:[]};}
export function commit(history:EditHistory,operation:Operation):EditHistory{
  const result=applyOperation(history.current,operation),entry={operation:clone(operation),before:clone(history.current),after:clone(result.master),warnings:result.warnings};
  return {current:clone(result.master),past:[...history.past,entry],future:[]};
}
/** Undo restores exact prior snapped state; inverse affine transforms would accumulate rounding error. */
export function undo(history:EditHistory):EditHistory{const entry=history.past.at(-1);return entry?{current:clone(entry.before),past:history.past.slice(0,-1),future:[entry,...history.future]}:history;}
export function redo(history:EditHistory):EditHistory{const entry=history.future[0];return entry?{current:clone(entry.after),past:[...history.past,entry],future:history.future.slice(1)}:history;}
