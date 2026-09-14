import {EditorEngine} from './editor-engine';
import type {EditorReply,EditorRequest} from './editor-protocol';
import type {SettlementResult} from './settle.worker';
import {DEFERRED_GEOMETRY_OPERATIONS} from '../../../packages/core/src/ops';
import {writeRecovery} from './recovery';
export {EditorEngine} from './editor-engine';

const scope=globalThis as unknown as {postMessage?:(reply:EditorReply,transfer?:Transferable[])=>void;onmessage?:((event:MessageEvent<EditorRequest>)=>void)|null};
if(typeof scope.postMessage==='function'&&typeof document==='undefined'){
  const engine=new EditorEngine();let child:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined,generation=0,dirty=false,failure:Error|undefined;
  const waiting:{resolve:()=>void;reject:(error:Error)=>void}[]=[];
  const send=(reply:EditorReply)=>{const transfer:Transferable[]=[];if(reply.type==='ready'||reply.type==='state'||reply.type==='settled')transfer.push(reply.render.grid.buffer as ArrayBuffer,reply.render.changedPixelsMask.buffer as ArrayBuffer);else if(reply.type==='export')transfer.push(reply.bytes.buffer as ArrayBuffer);scope.postMessage!(reply,transfer);};
  const fail=(error:Error)=>{failure=error;child?.terminate();child=undefined;for(const waiter of waiting.splice(0))waiter.reject(error);send({type:'error',requestId:-1,message:`Preview could not finish: ${error.message}. Your edit is retained in browser recovery; reload to retry.`});};
  const start=()=>{
    clearTimeout(timer);timer=undefined;if(!dirty||child)return;
    const own=++generation,sequence=engine.sequence,input=engine.settlementInput();child=new Worker(new URL('./settle.worker.ts',import.meta.url),{type:'module'});
    child.onmessage=({data}:{data:SettlementResult|{error:string}})=>{
      if(own!==generation)return;
      child?.terminate();child=undefined;
      if('error'in data){fail(new Error(data.error));return;}
      if(sequence!==engine.sequence){start();return;}
      engine.acceptDerived(data.state,data.cache);dirty=false;failure=undefined;
      if(!input.topologyPending&&!input.geometryDirty)delete data.state.geometry;
      const {document,...state}=data.state;
      send({...state,type:'settled',requestId:-1,patch:{replaceFaceColors:document.master.geometry.faceColors}});for(const waiter of waiting.splice(0))waiter.resolve();
    };
    child.onerror=event=>{if(own===generation)fail(new Error(event.message||'Background worker stopped'));};
    child.onmessageerror=()=>{if(own===generation)fail(new Error('Unreadable background worker result'));};
    child.postMessage(input);
  };
  const schedule=()=>{dirty=true;failure=undefined;generation++;child?.terminate();child=undefined;clearTimeout(timer);timer=setTimeout(start,100);};
  const settled=():Promise<void>=>{if(failure)return Promise.reject(failure);if(!dirty)return Promise.resolve();start();return new Promise((resolve,reject)=>waiting.push({resolve,reject}));};
  const quickOperations=new Set<string>([...DEFERRED_GEOMETRY_OPERATIONS,'setEdgeStyle','setStrokeVisibility','setPalette']);
  const quick=(request:EditorRequest)=>request.type==='undo'||request.type==='redo'||(request.type==='hitFace'&&!engine.isTopologyPending)||(request.type==='action'&&request.action.type==='operation'&&(quickOperations.has(request.action.operation.t)||(request.action.operation.t==='setFaceColor'&&!engine.isTopologyPending)));
  let commands=Promise.resolve();
  const run=async(request:EditorRequest)=>{
    if(request.type==='recovery'){
      // The canonical graph is already here: clone it into IndexedDB off the UI thread.
      // Skip an obsolete checkpoint; the newer commit has its own ordered checkpoint.
      if(request.expectedSequence===engine.sequence){const {document}=engine.settlementInput();await writeRecovery(document.id,{document,pending:request.pending,savedAt:Date.now()});}
      send({type:'ack',requestId:request.requestId});return;
    }
    if(request.type==='flush'){
      // A save barrier does not occupy the command queue: subsequent drags can cancel its render.
      void settled().then(()=>send({type:'flushed',requestId:request.requestId})).catch(error=>send({type:'error',requestId:request.requestId,message:String(error)}));return;
    }
    if(request.type!=='init'&&request.type!=='ack'&&!quick(request))await settled();
    const interactive=request.type==='action'||request.type==='undo'||request.type==='redo';
    const reply=interactive?engine.handleInteractive(request):engine.handle(request);send(reply);
    if(reply.type==='committed')schedule();
  };
  scope.onmessage=event=>{commands=commands.then(()=>run(event.data)).catch(error=>send({type:'error',requestId:event.data.requestId,message:error instanceof Error?error.message:String(error)}));};
}
