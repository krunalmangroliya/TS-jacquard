import type {DesignRecord,EditorAction} from '../../../packages/app-model/src/index';
import type {DesignObject,Edge,Face,FaceColor,Master,Node} from '../../../packages/core/src/types';
import {applyOperation,validateOperation,type Operation} from '../../../packages/core/src/ops';

type Fields<T>={[K in keyof T]?:T[K]|null};
type MasterFields=Omit<Master,'geometry'|'objects'|'version'|'createdAt'|'updatedAt'>;
type DocumentFields=Omit<DesignRecord,'master'|'operations'|'revision'|'createdAt'|'updatedAt'>;
/** Forward worker edits. Null removes a table entry or an optional metadata field. */
export interface EditorDocumentPatch {
  nodes?:Record<string,Node|null>;
  edges?:Record<string,Edge|null>;
  faceColors?:Record<string,FaceColor|null>;
  /** Undoing geometry before its first settlement restores this authored partition exactly. */
  replaceFaceColors?:Record<string,FaceColor>;
  objects?:{changes:Record<string,DesignObject|null>;order?:string[]};
  master?:Fields<MasterFields>;
  document?:Fields<DocumentFields>;
  operations?:{prefix:number;items:Operation[]};
}

const tableKeys=new WeakMap<object,string[]>();
const incidentEdges=new WeakMap<object,Promise<Map<string,string[]>>>();
const own=(value:object,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
function keys(value:object):string[]{let cached=tableKeys.get(value);if(!cached){cached=Object.keys(value);tableKeys.set(value,cached);}return cached;}
const yieldToInput=():Promise<void>=>{
  const scheduler=(globalThis as unknown as {scheduler?:{yield:()=>Promise<void>}}).scheduler;
  return scheduler?.yield?scheduler.yield():new Promise(resolve=>setTimeout(resolve,0));
};
function assign<T>(target:Record<string,T>,id:string,value:T):void {
  if(id==='__proto__')Object.defineProperty(target,id,{value,writable:true,enumerable:true,configurable:true});else target[id]=value;
}
/** Warm keys and the cooperative incident-edge index while the first preview is being prepared. */
export function primeEditorPatchKeys(document:DesignRecord):void {
  keys(document.master.geometry.nodes);keys(document.master.geometry.edges);keys(document.master.geometry.faceColors);
  void adjacency(document.master.geometry.edges).catch(()=>incidentEdges.delete(document.master.geometry.edges));
}
async function patchTable<T>(source:Record<string,T>,patch:Record<string,T|null>|undefined):Promise<Record<string,T>> {
  if(!patch)return source;
  const changed=Object.keys(patch);if(!changed.length)return source;
  const sourceKeys=keys(source),membershipChanged=changed.some(id=>patch[id]===null?own(source,id):!own(source,id));
  const result:Record<string,T>={},nextKeys=membershipChanged?[] as string[]:sourceKeys;
  let started=performance.now();
  // Keep the public plain-object model. Only the modified table is copied, in bounded tasks.
  for(let begin=0;begin<sourceKeys.length;begin+=512){
    const end=Math.min(sourceKeys.length,begin+512);
    for(let i=begin;i<end;i++){const id=sourceKeys[i];if(membershipChanged&&own(patch,id)&&patch[id]===null)continue;assign(result,id,source[id]);if(membershipChanged)nextKeys.push(id);}
    if(end<sourceKeys.length&&performance.now()-started>=4){await yieldToInput();started=performance.now();}
  }
  for(const id of changed){const value=patch[id];if(value===null){delete result[id];continue;}if(membershipChanged&&!own(source,id))nextKeys.push(id);assign(result,id,value);}
  tableKeys.set(result,nextKeys);return result;
}
function patchFields<T extends object>(source:T,patch:Fields<T>|undefined):T {
  if(!patch||!Object.keys(patch).length)return source;
  const result={...source};for(const [key,value] of Object.entries(patch)){if(value===null)delete result[key as keyof T];else (result as Record<string,unknown>)[key]=value;}return result;
}
/** Apply messages serially. Untouched values stay shared with earlier immutable snapshots. */
export async function applyEditorPatch(source:DesignRecord,patch:EditorDocumentPatch):Promise<DesignRecord> {
  const previous=source.master.geometry;
  const nodes=await patchTable(previous.nodes,patch.nodes),edges=await patchTable(previous.edges,patch.edges);
  if(edges!==previous.edges&&patch.edges&&incidentEdges.has(previous.edges)&&Object.entries(patch.edges).every(([id,edge])=>{const before=previous.edges[id];return !!edge&&!!before&&edge.nodeIds.length===before.nodeIds.length&&edge.nodeIds.every((nodeId,i)=>nodeId===before.nodeIds[i]);}))incidentEdges.set(edges,incidentEdges.get(previous.edges)!);
  const faceColors=patch.replaceFaceColors??await patchTable(previous.faceColors,patch.faceColors);
  const geometry=nodes===previous.nodes&&edges===previous.edges&&faceColors===previous.faceColors?previous:{nodes,edges,faceColors};
  let objects=source.master.objects;
  if(patch.objects){
    const changed=patch.objects.changes;
    if(patch.objects.order){const byId=new Map(objects.map(object=>[object.id,object]));for(const [id,object] of Object.entries(changed)){if(object)byId.set(id,object);else byId.delete(id);}objects=patch.objects.order.map(id=>{const object=byId.get(id);if(!object)throw new Error(`Missing patched object ${id}`);return object;});}
    else if(Object.keys(changed).length){objects=objects.flatMap(object=>own(changed,object.id)?changed[object.id]?[changed[object.id]!]:[]:[object]);const existing=new Set(source.master.objects.map(object=>object.id));for(const [id,object] of Object.entries(changed))if(object&&!existing.has(id))objects.push(object);}
  }
  let master=patchFields(source.master,patch.master as Fields<Master>|undefined);
  if(geometry!==master.geometry||objects!==master.objects)master={...master,geometry,objects};
  let document=patchFields(source,patch.document as Fields<DesignRecord>|undefined);
  if(master!==document.master)document={...document,master};
  if(patch.operations)document={...document,operations:[...source.operations.slice(0,patch.operations.prefix),...patch.operations.items]};
  return document;
}

async function adjacency(edges:Record<string,Edge>):Promise<Map<string,string[]>> {
  let pending=incidentEdges.get(edges);if(pending)return pending;
  pending=(async()=>{const index=new Map<string,string[]>();let budget=0,started=performance.now();
    for(const id of keys(edges))for(const nodeId of new Set(edges[id].nodeIds)){
      const list=index.get(nodeId);if(list)list.push(id);else index.set(nodeId,[id]);
      if(++budget%512===0&&performance.now()-started>=4){await yieldToInput();started=performance.now();}
    }
    return index;
  })();incidentEdges.set(edges,pending);return pending;
}

/** A small local graph preserves core handle/lock behavior without copying the master on the UI thread. */
export async function getOptimisticPatch(source:DesignRecord,action:EditorAction,faces?:Face[]):Promise<EditorDocumentPatch|undefined> {
  if(action.type==='metadata')return {document:{name:action.name,tags:action.tags},...(source.kind==='master'?{master:{name:action.name,tags:action.tags}}:{})};
  if(action.type!=='operation')return undefined;
  const operation=validateOperation(action.operation),master=source.master;
  if(operation.t==='setPalette')return {master:{palette:applyOperation(master,operation,{assumeValidated:true,faces}).master.palette}};
  if(operation.t==='setFaceColor'){
    if(!faces||master.objects.some(object=>object.hidden))return undefined;
    const result=applyOperation(master,operation,{assumeValidated:true,faces}).master.geometry.faceColors;
    return {faceColors:Object.fromEntries(Object.entries(result).filter(([id,color])=>color!==master.geometry.faceColors[id]))};
  }
  const edgeIds=new Set<string>(),nodeIds=new Set<string>();
  if(operation.t==='moveNodes')for(const node of operation.nodes)nodeIds.add(node.id);
  else if(operation.t==='setNodeKind')nodeIds.add(operation.nodeId);
  else if(operation.t==='setControls'){
    edgeIds.add(operation.edgeId);const edge=master.geometry.edges[operation.edgeId];if(edge)for(const id of [edge.nodeIds[operation.segIndex],edge.nodeIds[operation.segIndex+1]])if(id)nodeIds.add(id);
  }else if(operation.t==='insertNode'){
    if(master.geometry.nodes[operation.nodeId])throw new Error('The inserted node ID already exists');edgeIds.add(operation.edgeId);
  }else if(operation.t==='setEdgeStyle')edgeIds.add(operation.edgeId);
  else if(operation.t==='setStrokeVisibility')for(const id of operation.edgeIds)edgeIds.add(id);
  else return undefined;
  if(nodeIds.size){const index=await adjacency(master.geometry.edges);for(const id of nodeIds)for(const edgeId of index.get(id)??[])edgeIds.add(edgeId);}
  const nodes:Record<string,Node>={},edges:Record<string,Edge>={};
  for(const id of edgeIds){const edge=master.geometry.edges[id];if(edge){assign(edges,id,edge);for(const nodeId of edge.nodeIds)nodeIds.add(nodeId);}}
  for(const id of nodeIds)if(master.geometry.nodes[id])assign(nodes,id,master.geometry.nodes[id]);
  const objects=master.objects.flatMap(object=>{const selected=object.edgeIds.filter(id=>edgeIds.has(id));return selected.length?[{...object,edgeIds:selected}]:[];});
  const local={...master,objects,geometry:{nodes,edges,faceColors:{}}};
  const result=applyOperation(local,operation,{assumeValidated:true,deferTopology:true,faces});
  const changedNodes=Object.fromEntries(Object.entries(result.master.geometry.nodes).filter(([id,node])=>node!==nodes[id]));
  const changedEdges=Object.fromEntries(Object.entries(result.master.geometry.edges).filter(([id,edge])=>edge!==edges[id]));
  return {...(Object.keys(changedNodes).length?{nodes:changedNodes}:{}),...(Object.keys(changedEdges).length?{edges:changedEdges}:{})};
}
