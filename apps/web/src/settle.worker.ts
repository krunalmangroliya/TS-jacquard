import {EditorEngine} from './editor-engine';
import {buildPlanarMap,resolveFaceColors,trackFaces} from '../../../packages/core/src/topology';
import type {EditorState} from './editor-protocol';

export type SettlementInput=ReturnType<EditorEngine['settlementInput']>;
export type SettlementResult={state:EditorState;cache:ReturnType<EditorEngine['derivedCache']>};
export function settle(input:SettlementInput):SettlementResult {
  let {document,previousFaces:faces}=input;
  const warnings=[...input.warnings];
  if(input.topologyPending){
    const topology=buildPlanarMap(document.master.geometry,document.master.bounds,document.master.repeat);
    const tracked=input.restoreFaceColors==='resolve'?{faces:topology.faces,...resolveFaceColors(topology.faces,document.master.geometry.faceColors)}:trackFaces(faces,document.master.geometry.faceColors,topology.faces);
    const reconciled=input.restoreFaceColors==='track-resolve'?{faces:topology.faces,...resolveFaceColors(topology.faces,tracked.faceColors)}:tracked;faces=reconciled.faces;
    warnings.push(...topology.warnings,...tracked.warnings,...reconciled.warnings);
    document={...document,master:{...document.master,geometry:{...document.master.geometry,faceColors:reconciled.faceColors}}};
  }
  const engine=new EditorEngine(),reply=engine.handle({type:'init',requestId:1,document,profile:input.profile,previewWidth:input.previewWidth,preparedFaces:faces});
  if(reply.type!=='ready'&&reply.type!=='state')throw new Error(reply.type==='error'?reply.message:'Could not render the design');
  const cache=engine.derivedCache();cache.topologyWarnings=[...new Set([...cache.topologyWarnings,...warnings])];
  reply.warnings=[...new Set([...reply.warnings,...cache.topologyWarnings])];
  return {state:reply,cache};
}
const scope=globalThis as unknown as {postMessage:(value:unknown,transfer?:Transferable[])=>void;onmessage:((event:MessageEvent<SettlementInput>)=>void)|null};
if(typeof scope.postMessage==='function'&&typeof document==='undefined')scope.onmessage=({data}:{data:SettlementInput})=>{
  try{const result=settle(data);scope.postMessage(result,[result.state.render.grid.buffer as ArrayBuffer,result.state.render.changedPixelsMask.buffer as ArrayBuffer]);}
  catch(error){scope.postMessage({error:error instanceof Error?error.message:String(error)});}
};
