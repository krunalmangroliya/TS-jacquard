import {useEffect,useRef,useState} from 'react';
import type {DesignRecord,EditorAction,WorkspaceSettings} from '../../../packages/app-model/src/index';
import type {Vec2} from '../../../packages/core/src/types';
import type {EditorReply,EditorState,EditorGeometry} from './editor-protocol';
import {api,ApiError,clientId,downloadBytes} from './api';
import {readRecovery,clearRecovery,type Recovery} from './recovery';
import {DEFERRED_GEOMETRY_OPERATIONS} from '../../../packages/core/src/ops';
import {applyEditorPatch,primeEditorPatchKeys,getOptimisticPatch} from './editor-patch';

const problemText=(problem:unknown)=>problem instanceof Error?problem.message:String(problem);
type Callback={resolve:(reply:EditorReply)=>void;reject:(error:Error)=>void};
const lockReleases=new Map<string,Promise<unknown>>();
const instantOperations=new Set<string>([...DEFERRED_GEOMETRY_OPERATIONS,'setEdgeStyle','setStrokeVisibility','setFaceColor','setPalette']);

export function useEditor(initial:DesignRecord,settings:WorkspaceSettings){
  const [state,setState]=useState<EditorState>(),[geometry,setGeometry]=useState<EditorGeometry>(),[busy,setBusy]=useState(true),[error,setError]=useState(''),[saveStatus,setSaveStatus]=useState('Opening design…'),[readOnly,setReadOnly]=useState(false),[conflict,setConflict]=useState<Recovery>();
  const [interactiveDocument,setInteractiveDocument]=useState<DesignRecord>(),[renderedDocument,setRenderedDocument]=useState<DesignRecord>(),[renderPending,setRenderPending]=useState(false);
  const worker=useRef<Worker|null>(null),record=useRef(initial),sequence=useRef(0),savedSequence=useRef(0),workerSequence=useRef(0),requestId=useRef(0),inFlight=useRef<Promise<DesignRecord>|null>(null),pending=useRef<{id:number;action:EditorAction}[]>([]),alive=useRef(false),readonlyRef=useRef(false),busyRef=useRef(true),readyRef=useRef(false),workerFailure=useRef<Error|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),recoveryWrite=useRef<Promise<void>>(Promise.resolve()),work=useRef<Promise<void>>(Promise.resolve());
  const callbacks=useRef(new Map<number,Callback>());
  const settledGeometry=useRef<EditorGeometry|undefined>(undefined);
  const previewGeneration=useRef(0),previewWork=useRef(Promise.resolve()),previewCache=useRef<{base:DesignRecord;actions:EditorAction[];document:DesignRecord}|undefined>(undefined);
  const recoveryNeedsSync=useRef(false);
  const profile=(id=record.current.profileId)=>settings.profiles.find(p=>p.id===id)??settings.profiles.find(p=>p.id===settings.defaultProfileId)??settings.profiles[0];
  const showError=(problem:unknown)=>{if(alive.current)setError(problemText(problem));};
  const setWorking=(value:boolean)=>{busyRef.current=value;if(alive.current)setBusy(value);};
  // Failed transactions must not poison subsequent writes. Clears use this same queue.
  const queueRecovery=(operation:()=>Promise<void>)=>{
    const next=recoveryWrite.current.catch(()=>{}).then(operation);recoveryWrite.current=next;
    void next.catch(()=>{});return next;
  };
  const previewPending=()=>{
    const own=++previewGeneration.current,base=record.current,actions=pending.current.map(p=>p.action);
    if(!actions.length){previewCache.current={base,actions,document:base};if(alive.current)setInteractiveDocument(base);return;}
    previewWork.current=previewWork.current.catch(()=>{}).then(async()=>{
      if(own!==previewGeneration.current||!alive.current)return;
      const cached=previewCache.current,canExtend=cached?.base===base&&cached.actions.length<=actions.length&&cached.actions.every((action,i)=>action===actions[i]);
      let next=canExtend?cached!.document:base;
      for(let i=canExtend?cached!.actions.length:0;i<actions.length;i++){
        if(own!==previewGeneration.current||!alive.current)return;
        try{const patch=await getOptimisticPatch(next,actions[i],settledGeometry.current?.faces);if(own!==previewGeneration.current||!alive.current)return;if(patch)next=await applyEditorPatch(next,patch);}catch{/* The worker reports validation failures; retain the last valid visual. */}
      }
      if(own!==previewGeneration.current||!alive.current)return;
      previewCache.current={base,actions,document:next};setInteractiveDocument(next);
    });
  };
  const persist=()=>{const message={type:'recovery',expectedSequence:workerSequence.current,pending:pending.current.map(p=>p.action)};return queueRecovery(async()=>{await ask(message);});};
  const checkpointRecovery=()=>queueRecovery(async()=>{
    if(sequence.current===savedSequence.current&&!pending.current.length)await clearRecovery(initial.id);
    else await ask({type:'recovery',expectedSequence:workerSequence.current,pending:pending.current.map(p=>p.action)});
    recoveryNeedsSync.current=false;
  });
  const ask=(message:Record<string,unknown>,id=++requestId.current):Promise<EditorReply>=>new Promise((resolve,reject)=>{
    const w=worker.current;if(!w||!alive.current||workerFailure.current){reject(workerFailure.current??new Error('The design editor has closed'));return;}
    callbacks.current.set(id,{resolve,reject});try{w.postMessage({...message,requestId:id});}catch(problem){callbacks.current.delete(id);reject(problem instanceof Error?problem:new Error(String(problem)));}
  });
  const acknowledge=(saved:DesignRecord)=>{
    if(saved.revision<record.current.revision)return;
    record.current={...record.current,revision:saved.revision,updatedAt:saved.updatedAt,master:{...record.current.master,version:saved.master.version,updatedAt:saved.master.updatedAt}};
    if(alive.current&&worker.current&&!workerFailure.current)void ask({type:'ack',revision:saved.revision,version:saved.master.version,updatedAt:saved.updatedAt}).catch(showError);
    if(alive.current)setState(old=>old?{...old,document:record.current}:old);
    if(alive.current)setInteractiveDocument(old=>old?{...old,revision:saved.revision,updatedAt:saved.updatedAt,master:{...old.master,version:saved.master.version,updatedAt:saved.updatedAt}}:old);
  };
  async function settleWork(exact=true):Promise<void>{
    let observed:Promise<void>;do{
      observed=work.current;await observed;
      if(!alive.current||!readyRef.current||workerFailure.current)throw workerFailure.current??new Error('The design editor is not ready');
      if(observed!==work.current)continue;
      if(exact)await ask({type:'flush'});
    }while(observed!==work.current);
  }
  async function save():Promise<DesignRecord>{
    if(inFlight.current)return inFlight.current;
    const job=(async()=>{
      for(;;){
        // Includes recovery writes before dispatch as well as the worker result and resulting draft.
        await settleWork();if(readonlyRef.current)throw new Error('This design is read-only in this tab.');
        if(sequence.current===savedSequence.current){if(recoveryNeedsSync.current)await checkpointRecovery();if(alive.current)setSaveStatus('Saved on this PC');return record.current;}
        const savingSequence=sequence.current,document=record.current;if(alive.current)setSaveStatus('Saving to this PC…');
        const saved=await api<DesignRecord>(`/designs/${initial.id}`,{document,expectedRevision:document.revision,clientId},'PUT');
        acknowledge(saved);savedSequence.current=savingSequence;recoveryNeedsSync.current=true;
        // Inspect live state inside the queue so a new edit cannot be erased by a delayed clear.
        await checkpointRecovery().catch(problem=>{throw new Error(`Server save succeeded, but browser recovery needs retry: ${problemText(problem)}`);});
        if(alive.current)setSaveStatus(sequence.current===savingSequence&&!pending.current.length?'Saved on this PC':'Saving latest changes…');
        // Loop also waits for edits accepted during the network request; never return an unsaved newer record.
      }
    })().catch((problem:unknown)=>{
      if(alive.current){setSaveStatus(recoveryNeedsSync.current?'Browser recovery needs retry · server save succeeded':'Server save needs retry · browser recovery retained');setError(problemText(problem));if(problem instanceof ApiError&&(problem.status===409||problem.status===423)){readonlyRef.current=true;setReadOnly(true);}}
      throw problem;
    });
    inFlight.current=job;void job.finally(()=>{if(inFlight.current===job)inFlight.current=null;}).catch(()=>{});return job;
  }
  const scheduleSave=()=>{if(!alive.current||readonlyRef.current)return;clearTimeout(timer.current);timer.current=setTimeout(()=>void save().catch(()=>{}),1200);};
  useEffect(()=>{
    alive.current=true;readyRef.current=false;workerFailure.current=null;record.current=initial;sequence.current=0;savedSequence.current=0;workerSequence.current=0;pending.current=[];readonlyRef.current=false;
    setReadOnly(false);setConflict(undefined);setInteractiveDocument(undefined);setRenderedDocument(undefined);setRenderPending(false);setWorking(true);setError('');setSaveStatus('Opening design…');
    let cancelled=false,held=false,heartbeat:ReturnType<typeof setInterval>|undefined;
    const w=new Worker(new URL('./editor.worker.ts',import.meta.url),{type:'module'});worker.current=w;
    const current=()=>!cancelled&&worker.current===w;
    const release=()=>{
      if(!held)return;held=false;
      // React remounts on the same page can already be using this page's lock.
      if(worker.current&&worker.current!==w&&record.current.id===initial.id)return;
      const releasing=fetch(`/api/designs/${initial.id}/lock`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId}),keepalive:true}).catch(()=>{});
      lockReleases.set(initial.id,releasing);void releasing.finally(()=>{if(lockReleases.get(initial.id)===releasing)lockReleases.delete(initial.id);});
    };
    const rejectCallbacks=(problem:Error)=>{for(const callback of callbacks.current.values())callback.reject(problem);callbacks.current.clear();};
    const failed=(message:string)=>{if(!current())return;const problem=new Error(message);workerFailure.current=problem;readyRef.current=false;rejectCallbacks(problem);setError(message);setWorking(false);};
    let replies=Promise.resolve();
    const receive=async(data:EditorReply)=>{
      if(!current())return;
      const callback=callbacks.current.get(data.requestId);
      if(data.type==='error'){
        const wasPending=pending.current.some(p=>p.id===data.requestId);pending.current=pending.current.filter(p=>p.id!==data.requestId);previewPending();setError(data.message);
        if(wasPending)await persist().catch(problem=>showError(`Could not update local recovery: ${problemText(problem)}`));
        if(current()){callbacks.current.delete(data.requestId);callback?.reject(new Error(data.message));}return;
      }
      if(data.type==='ready'||data.type==='state'||data.type==='committed'||data.type==='settled'){
        if(data.editSequence<workerSequence.current)return;
        const nextDocument=data.type==='committed'||data.type==='settled'?await applyEditorPatch(record.current,data.patch):data.document;
        if(!current())return;
        record.current={...nextDocument,revision:record.current.revision,updatedAt:record.current.updatedAt,master:{...nextDocument.master,version:record.current.master.version,updatedAt:record.current.master.updatedAt}};
        pending.current=pending.current.filter(p=>p.id!==data.requestId);
        previewPending();
        if(data.type==='committed'){
          setRenderPending(true);setState(old=>old?{...old,...data,type:'state',document:record.current}:old);
        }else{
          if(data.geometry){settledGeometry.current=data.geometry;setGeometry(data.geometry);}setState({...data,type:data.type==='ready'?'ready':'state',document:record.current});setRenderedDocument(record.current);setRenderPending(false);
        }
        if(data.type==='ready'){primeEditorPatchKeys(record.current);readyRef.current=true;setSaveStatus(readonlyRef.current?'Read-only · open in another tab':'Saved on this PC');}
        else if(data.editSequence!==workerSequence.current){
          workerSequence.current=data.editSequence;sequence.current++;
          await persist().catch(problem=>showError(`Could not update local recovery: ${problemText(problem)}`));scheduleSave();
        }else if(data.type==='settled'||(data.type==='state'&&data.requestId===-1)){await persist().catch(problem=>showError(`Could not update local recovery: ${problemText(problem)}`));}
      }
      // Resolve only after refs and recovery have consumed the reply; save() can now safely snapshot it.
      if(current()){callbacks.current.delete(data.requestId);callback?.resolve(data);}
    };
    w.onmessage=({data}:{data:EditorReply})=>{
      // Recovery acknowledgements must bypass the document queue whose handler is awaiting them.
      if(data.type==='ack'||data.type==='error')void receive(data).catch(problem=>failed(problemText(problem)));
      else replies=replies.then(()=>receive(data)).catch(problem=>failed(problemText(problem)));
    };
    w.onerror=event=>failed(event.message||'The design worker stopped. Reload to restore the saved draft.');
    w.onmessageerror=()=>failed('The design worker returned unreadable data. Reload to restore the saved draft.');
    const acquire=async(retry:boolean)=>{
      await lockReleases.get(initial.id);if(!current())return false;
      let lock=await api<{acquired:boolean}>(`/designs/${initial.id}/lock`,{clientId});
      for(let attempt=0;retry&&!lock.acquired&&attempt<3&&current();attempt++){
        await new Promise(resolve=>setTimeout(resolve,200*(attempt+1)));if(!current())return false;
        lock=await api<{acquired:boolean}>(`/designs/${initial.id}/lock`,{clientId});
      }
      if(lock.acquired)held=true;if(!current()){release();return false;}return lock.acquired;
    };
    const renew=()=>{clearInterval(heartbeat);heartbeat=setInterval(()=>{if(!current()||readonlyRef.current)return;void acquire(false).then(acquired=>{if(current()&&!acquired){readonlyRef.current=true;setReadOnly(true);setError('Editing is now locked by another tab. Your recovery draft is retained.');}}).catch(()=>{if(current())setSaveStatus('Connection lost · recovery stays in this browser');});},60_000);};
    const opening=(async()=>{
      const acquired=await acquire(true);if(!current())return;if(!acquired){readonlyRef.current=true;setReadOnly(true);}
      const recovery=await readRecovery(initial.id);if(!current())return;
      let openingDocument=initial,replay:EditorAction[]=[];
      if(recovery&&!readonlyRef.current){
        if(recovery.document.revision===initial.revision){openingDocument=recovery.document;replay=recovery.pending;record.current=openingDocument;sequence.current=1;setSaveStatus('Restoring unsaved local work…');}
        else{setConflict(recovery);readonlyRef.current=true;setReadOnly(true);setError('A local recovery draft differs from the saved version. Download or discard it before editing.');}
      }
      await ask({type:'init',document:openingDocument,profile:profile(openingDocument.profileId),previewWidth:1200});
      if(recovery&&!readonlyRef.current&&current())setSaveStatus('Restoring unsaved local work…');
      pending.current=replay.map(action=>({id:++requestId.current,action}));
      for(const {id,action} of [...pending.current]){
        if(!current())return;
        const dispatchId=++requestId.current;pending.current=pending.current.map(item=>item.id===id?{...item,id:dispatchId}:item);
        await ask({type:'action',action,profile:profile(action.type==='size'?action.profileId:undefined)},dispatchId);
      }
      if(!current())return;if(recovery&&!readonlyRef.current)scheduleSave();if(acquired)renew();
    })();
    work.current=opening;
    void opening.catch(problem=>{if(current())setError(problemText(problem));}).finally(()=>{if(current())setWorking(false);});
    const unload=(event:BeforeUnloadEvent)=>{if((busyRef.current&&readyRef.current)||pending.current.length||sequence.current>savedSequence.current){event.preventDefault();event.returnValue='';}};
    const hide=()=>{clearInterval(heartbeat);release();};
    const show=(event:PageTransitionEvent)=>{if(!event.persisted||!current())return;void acquire(true).then(acquired=>{if(!current())return;if(!acquired){readonlyRef.current=true;setReadOnly(true);setError('This design was opened in another tab while this page was suspended.');}else renew();}).catch(showError);};
    window.addEventListener('beforeunload',unload);window.addEventListener('pagehide',hide);window.addEventListener('pageshow',show);
    return()=>{
      cancelled=true;alive.current=false;readyRef.current=false;clearInterval(heartbeat);clearTimeout(timer.current);window.removeEventListener('beforeunload',unload);window.removeEventListener('pagehide',hide);window.removeEventListener('pageshow',show);
      rejectCallbacks(new Error('The design editor has closed'));w.onmessage=null;w.onerror=null;w.onmessageerror=null;w.terminate();if(worker.current===w)worker.current=null;release();
    };
  },[initial.id]);
  async function action(value:EditorAction){
    if(readonlyRef.current||busyRef.current||!readyRef.current)return;
    const quick=value.type==='operation'&&instantOperations.has(value.operation.t);
    setError('');setSaveStatus('Keeping browser recovery…');if(!quick)setWorking(true);let id=++requestId.current;pending.current.push({id,action:structuredClone(value)});previewPending();
    const previous=work.current;
    const job=(async()=>{
      await previous;
      // Let the live canvas paint before scheduling the durable worker command.
      if(quick)await new Promise<void>(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
      try{await persist();}catch(problem){pending.current=pending.current.filter(p=>p.id!==id);previewPending();throw new Error(`Cannot store a recovery draft: ${problemText(problem)}. Retry after browser storage is available.`);}
      // A save acknowledgement may be posted during the recovery write; allocate dispatch order now.
      if(alive.current)setSaveStatus('Updating design · recovery in this browser');
      const dispatchId=++requestId.current;pending.current=pending.current.map(item=>item.id===id?{...item,id:dispatchId}:item);id=dispatchId;
      await ask({type:'action',action:value,profile:profile(value.type==='size'?value.profileId:undefined)},id);
    })(),barrier=job.catch(()=>{});work.current=barrier;
    try{await job;}catch(problem){showError(problem);if(alive.current)setSaveStatus(workerFailure.current?'Worker stopped · browser recovery retained':'Edit not applied · previous state retained');}finally{if(work.current===barrier)setWorking(false);}
  }
  async function history(type:'undo'|'redo'){
    if(readonlyRef.current||busyRef.current||!readyRef.current)return;setSaveStatus(type==='undo'?'Undoing edit · updating browser recovery…':'Redoing edit · updating browser recovery…');setWorking(true);
    const job=work.current.then(()=>ask({type})).then(()=>{}),barrier=job.catch(()=>{});work.current=barrier;
    try{await job;}catch(problem){showError(problem);if(alive.current)setSaveStatus(workerFailure.current?'Worker stopped · browser recovery retained':'Edit not applied · previous state retained');}finally{if(work.current===barrier)setWorking(false);}
  }
  async function hitFace(point:Vec2){await settleWork(false);const reply=await ask({type:'hitFace',point});return reply.type==='hitFace'?reply:null;}
  async function exportPreview(format:'bmp'|'png'|'json'){try{await settleWork();const reply=await ask({type:'export',format});if(reply.type==='export')downloadBytes(reply.bytes,reply.filename,reply.mime);}catch(problem){showError(problem);}}
  function acceptServer(saved:DesignRecord){acknowledge(saved);void queueRecovery(async()=>{if(sequence.current>savedSequence.current||pending.current.length)await ask({type:'recovery',expectedSequence:workerSequence.current,pending:pending.current.map(p=>p.action)});}).catch(showError);}
  return{state,geometry,interactiveDocument,renderedDocument,renderPending,busy,error,setError,saveStatus,readOnly,conflict,action,history,hitFace,exportPreview,save,acceptServer,getDocument:()=>record.current,discardRecovery:async()=>{await queueRecovery(()=>clearRecovery(initial.id));location.reload();}};
}
