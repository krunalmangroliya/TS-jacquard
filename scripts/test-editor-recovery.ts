import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { installedBrowser } from '../packages/eval/src/browser-check';

/** Isolated browser harness: fake API/worker/storage, no data/jdm or personal browser profile. */
interface CheckResult { checks:string[]; clientId:string }

const source=String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {useEditor} from './apps/web/src/useEditor';
import {clientId} from './apps/web/src/api';
import {clientId as libraryClientId} from './apps/web/src/ui';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async check=>{const end=Date.now()+6000;while(!check()){if(Date.now()>end)throw Error('Timed out waiting for hook');await sleep(5);}};
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const result=[];
let c,root,hook,mountNumber=0;
const initial=()=>({id:'doc',kind:'master',name:'Original',tags:[],master:{version:1,updatedAt:'old',geometry:{nodes:{},edges:{},faceColors:{}},objects:[]},revision:1,updatedAt:'old',profileId:'p',operations:[],pixelOverrides:[]});
const settings={profiles:[{id:'p',epi:100,ppi:100}],defaultProfileId:'p'};
function App({record}){hook=useEditor(record,settings);return <span>{hook.saveStatus}</span>;}
window.__recovery={
 read:async()=>{await sleep(c.recoveryDelay);return structuredClone(c.draft);},
 write:async(id,value)=>{c.writeStarts++;await sleep(c.recoveryDelay);if(c.failWrites>0){c.failWrites--;throw Error('Injected IndexedDB transaction failure');}c.draft=structuredClone(value);c.writes.push(structuredClone(value));},
 clear:async()=>{c.clearStarts++;await sleep(c.clearDelay);if(c.failClears>0){c.failClears--;throw Error('Injected recovery clear failure');}c.draft=undefined;c.clears++;}
};
class FakeWorker {
 constructor(){this.document=undefined;this.seq=0;this.terminated=false;this.tail=Promise.resolve();c.workers.push(this);}
 postMessage(message){c.posts.push(message);this.tail=this.tail.then(async()=>{await sleep(c.workerDelay);if(this.terminated)return;if(c.crash&&message.type==='action'){this.onerror?.({message:'Injected worker failure'});return;}if(message.type==='init'){this.document=structuredClone(message.document);this.reply(message,'ready');}
 else if(message.type==='action'){if(message.action.type==='metadata'){this.document.name=message.action.name;this.document.tags=message.action.tags;}this.seq++;this.reply(message,'state');}
 else if(message.type==='ack'){this.document.revision=message.revision;this.document.updatedAt=message.updatedAt;this.document.master.version=message.version;this.onmessage?.({data:{type:'ack',requestId:message.requestId}});}
 else if(message.type==='hitFace')this.onmessage?.({data:{type:'hitFace',requestId:message.requestId,faceId:null}});
 else if(message.type==='flush')this.onmessage?.({data:{type:'flushed',requestId:message.requestId}});
 else if(message.type==='recovery'){try{if(message.expectedSequence===this.seq)await window.__recovery.write('doc',{document:this.document,pending:message.pending,savedAt:Date.now()});this.onmessage?.({data:{type:'ack',requestId:message.requestId}});}catch(error){this.onmessage?.({data:{type:'error',requestId:message.requestId,message:error.message}});}}
 });}
 reply(message,type){this.onmessage?.({data:{type,requestId:message.requestId,document:structuredClone(this.document),editSequence:this.seq,canUndo:this.seq>0,canRedo:false,warnings:[],render:{},stats:{},...(type==='ready'?{geometry:{paths:{},faces:[]}}:{})}});}
 terminate(){this.terminated=true;}
}
window.Worker=FakeWorker;
window.fetch=async(url,options={})=>{const method=options.method??'GET',body=options.body?JSON.parse(options.body):undefined;c.requests.push({url:String(url),method,body});
 if(String(url).endsWith('/lock')){await sleep(c.lockDelay);return Response.json({acquired:true});}
 if(method==='PUT'){c.puts.push(structuredClone(body.document));await sleep(c.saveDelay);return Response.json({...body.document,revision:++c.serverRevision,updatedAt:'saved',master:{...body.document.master,version:c.serverRevision,updatedAt:'saved'}});}
 throw Error('Unexpected fetch '+url);
};
async function reset(overrides={}){if(root){root.unmount();await sleep(20);}hook=undefined;c={draft:undefined,writes:[],puts:[],posts:[],requests:[],workers:[],writeStarts:0,clearStarts:0,clears:0,failWrites:0,failClears:0,workerDelay:40,recoveryDelay:10,clearDelay:10,saveDelay:40,lockDelay:0,serverRevision:1,crash:false,...overrides};root=createRoot(document.getElementById('root'));root.render(<App key={++mountNumber} record={initial()}/>);await until(()=>hook&&!hook.busy&&hook.state);return hook;}
const edit=name=>({type:'metadata',name,tags:[]});
window.run=async()=>{
 await reset();let h=hook;const a=h.action(edit('Immediate'));const saved=await h.save();await a;assert(saved.name==='Immediate'&&c.puts[0]?.name==='Immediate','Immediate save returned stale document');result.push('Immediate save waits for recovery and worker');
 await reset({saveDelay:100});h=hook;await h.action(edit('First'));const saving=h.save();await until(()=>c.puts.length===1);await hook.action(edit('Second'));const newest=await saving;assert(newest.name==='Second'&&c.puts.map(d=>d.name).join(',')==='First,Second','Save did not drain an in-flight edit');result.push('Save includes edits accepted during PUT');
 await reset({failWrites:1});h=hook;await h.action(edit('Rejected'));assert(c.posts.filter(p=>p.type==='action').length===0,'Failed recovery write dispatched edit');await hook.action(edit('Retry'));const retry=await hook.save();assert(retry.name==='Retry','Failed recovery transaction poisoned the queue');result.push('Failed IndexedDB transaction does not poison retry');
 await reset({failClears:1});await hook.action(edit('Clear retry'));let clearFailed=false;await hook.save().catch(()=>{clearFailed=true;});assert(clearFailed&&c.puts.length===1,'Injected clear failure was not detected after server save');await hook.save();assert(c.puts.length===1&&c.draft===undefined,'Retry repeated the PUT or left stale recovery');result.push('Failed recovery clear retries without repeating the server PUT');
 await reset({clearDelay:100,saveDelay:70});await hook.action(edit('Before clear'));const clearing=hook.save();await until(()=>c.clearStarts===1);const after=hook.action(edit('After clear'));await after;const clearSaved=await clearing;assert(clearSaved.name==='After clear'&&c.puts.at(-1).name==='After clear','Recovery clear erased a concurrent edit');assert(c.writes.some(d=>d.pending.some(p=>p.name==='After clear')),'New pending action was not durable');result.push('Recovery clear and new draft writes remain ordered');
 await reset({workerDelay:100,recoveryDelay:40});await hook.action(edit('Ack base'));const ackSave=hook.save();await until(()=>c.puts.length===1);const ackEdit=hook.action(edit('After ack'));await ackEdit;await ackSave;const ids=c.posts.map(p=>p.requestId);assert(ids.every((id,i)=>!i||id>ids[i-1]),'Request IDs went backwards around a save acknowledgement');result.push('Acknowledgements cannot invert worker request IDs');
 await reset({crash:true});const crashing=hook.action(edit('Pending crash'));let rejected=false;await hook.save().catch(()=>{rejected=true;});await crashing;assert(rejected&&c.draft?.pending?.[0]?.name==='Pending crash','Worker crash lost pending draft or left save unresolved');result.push('Worker crash rejects waiters and retains pending recovery');
 await reset({workerDelay:120,recoveryDelay:80});const firstMove=hook.action({type:'operation',operation:{t:'moveNodes',nodes:[{id:'n1',to:{x:1,y:1}}]}});const nextMove=hook.action({type:'operation',operation:{t:'moveNodes',nodes:[{id:'n1',to:{x:2,y:2}}]}});assert(!hook.busy,'A quick edit blocked the canvas');await Promise.all([firstMove,nextMove]);await hook.save();assert(c.posts.filter(p=>p.type==='action').length===2&&hook.state.editSequence===2,'The second rapid drag was dropped');assert(c.writes.some(d=>d.pending.length===2),'Rapid edits were not both retained in recovery');result.push('Successive node edits remain interactive, ordered and durable');
 await reset({workerDelay:200});const selecting=hook.hitFace({x:1,y:1});await until(()=>c.posts.some(p=>p.type==='hitFace'));root.unmount();root=undefined;let closed=false;await selecting.catch(()=>{closed=true;});assert(closed,'Unmount leaked a worker callback');result.push('Unmount rejects outstanding worker callbacks');
 await reset({draft:{document:initial(),pending:[edit('Replay A'),edit('Replay B')],savedAt:1},workerDelay:80});assert(c.writes.some(d=>d.document.name==='Replay A'&&d.pending[0]?.name==='Replay B'),'Recovery replay discarded its remaining actions');assert(hook.getDocument().name==='Replay B','Recovery replay incomplete');await hook.save();result.push('Recovery replay preserves the unprocessed action tail');
 await reset();window.dispatchEvent(new PageTransitionEvent('pagehide'));await until(()=>c.requests.some(r=>r.method==='DELETE'));assert(clientId===libraryClientId(),'API and Library disagree on lock ID');result.push('Pagehide releases lock and Library shares page identity');
 root.unmount();root=undefined;await sleep(30);c.lockDelay=120;hook=undefined;const priorPosts=c.posts.length;root=createRoot(document.getElementById('root'));root.render(<App key={++mountNumber} record={initial()}/>);await until(()=>hook);root.unmount();root=undefined;await sleep(250);assert(c.workers.at(-1).terminated&&c.posts.length===priorPosts,'Unmounted initialization posted to a replacement worker');result.push('Unmount during lock acquisition cancels initialization');return {checks:result,clientId};
};
window.client=clientId;
`;
const built=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'esm',write:false,define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'mock-recovery',setup(build){build.onResolve({filter:/^\.\/recovery$/},()=>({path:'recovery',namespace:'mock'}));build.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const readRecovery=(...a)=>window.__recovery.read(...a);export const writeRecovery=(...a)=>window.__recovery.write(...a);export const clearRecovery=(...a)=>window.__recovery.clear(...a);'}));}}]});
const server=createServer((request,response)=>{response.setHeader('Content-Type',request.url==='/test.js'?'text/javascript':'text/html');response.end(request.url==='/test.js'?built.outputFiles[0].text:'<div id="root"></div><script type="module" src="/test.js"></script>');});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
const browser=await chromium.launch({executablePath:(await installedBrowser()).executablePath,headless:true});
try{const context=await browser.newContext();await context.addInitScript(()=>sessionStorage.setItem('jdm-client-id','same-cloned-session-id'));const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;await page.goto(origin);await page.waitForFunction(()=>typeof (window as unknown as {run:unknown}).run==='function');const result=await page.evaluate(()=>(window as unknown as {run:()=>Promise<CheckResult>}).run());
 const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>typeof (window as unknown as {client:unknown}).client==='string');const otherId=await other.evaluate(()=>(window as unknown as {client:string}).client);if(otherId===result.clientId)throw Error('Independent page identities collided');result.checks.push('Independent pages have distinct lock IDs despite sessionStorage');if(errors.length)throw Error(errors.join('\n'));await mkdir('output',{recursive:true});await writeFile('output/hook-robustness-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
