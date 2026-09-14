import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright';
import {installedBrowser} from '../packages/eval/src/browser-check';
import {DEFAULT_PROFILE,type Master} from '../packages/core/src/types';
import type {DesignRecord} from '../packages/app-model/src';

// Production worker bundle, real dense sample, isolated browser; no personal library writes.
const dist=path.resolve('apps/web/dist'),assets=await readdir(path.join(dist,'assets'));
const worker=assets.find(name=>name.startsWith('editor.worker-')&&name.endsWith('.js'))!;
assert(worker,'Build the app before running the latency regression');
const master=JSON.parse(await readFile('output/stroke-trial/sample-1-bb1795/master.json','utf8')) as Master;
const document:DesignRecord={id:'latency',kind:'master',name:master.name,tags:[],master,profileId:DEFAULT_PROFILE.id,sizeInput:{mode:'grid',widthPx:1200,linkAspect:true},rules:{minRegionPx:0,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false},pixelOverrides:[],operations:[],revision:1,createdAt:master.createdAt,updatedAt:master.updatedAt};
const node=Object.values(master.geometry.nodes).sort((a,b)=>Math.hypot(a.p.x-master.bounds.w/2,a.p.y-master.bounds.h/2)-Math.hypot(b.p.x-master.bounds.w/2,b.p.y-master.bounds.h/2))[0];
const server=createServer((request,response)=>{void(async()=>{
  if(request.url==='/'){response.setHeader('Content-Type','text/html');response.end('<title>Isolated editor worker regression</title>');return;}
  const target=path.resolve(dist,'.'+(request.url??''));if(!target.startsWith(dist+path.sep)){response.writeHead(404).end();return;}
  response.setHeader('Content-Type','text/javascript');response.end(await readFile(target));
})().catch(()=>response.writeHead(404).end());});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number};
const browser=await chromium.launch({headless:true,executablePath:(await installedBrowser()).executablePath});
try{
  const page=await browser.newPage();await page.addInitScript('globalThis.__name = value => value');await page.goto(`http://127.0.0.1:${address.port}`);
  const result=await page.evaluate(async({document,profile,node,worker})=>{
    const w=new Worker(`/assets/${worker}`,{type:'module'}),callbacks=new Map<number,{resolve:(data:any)=>void;reject:(error:Error)=>void}>();
    let id=0,latest:any,settledCount=0;
    w.onmessage=({data})=>{if(data.type==='settled'&&data.requestId===-1){latest=data;settledCount++;}const waiter=callbacks.get(data.requestId);if(!waiter)return;callbacks.delete(data.requestId);data.type==='error'?waiter.reject(Error(data.message)):waiter.resolve(data);};
    const ask=(message:any)=>new Promise<any>((resolve,reject)=>{const requestId=++id;callbacks.set(requestId,{resolve,reject});w.postMessage({...message,requestId});});
    const initStart=performance.now();await ask({type:'init',document,profile});const initMs=performance.now()-initStart;
    const commitMs:number[]=[];
    const move=async(dx:number)=>{const begin=performance.now(),reply=await ask({type:'action',action:{type:'operation',operation:{t:'moveNodes',nodes:[{id:node.id,to:{x:node.p.x+dx,y:node.p.y+0.5}}]}}});commitMs.push(performance.now()-begin);if(reply.type!=='committed')throw Error('Node edit blocked on full render');return reply;};
    await move(1);const barrier=ask({type:'flush'}),start=performance.now();await move(2);await move(3);
    await barrier;const totalSettleMs=performance.now()-start,saved=await ask({type:'snapshot'});
    if(saved.document.master.geometry.nodes[node.id].p.x!==Math.round((node.p.x+3)*64)/64)throw Error('Save barrier returned a stale node');
    if(latest?.editSequence!==3||!latest.render.grid.length)throw Error('Latest exact pixel render missing');
    await ask({type:'undo'});await ask({type:'flush'});const undone=await ask({type:'snapshot'});
    if(undone.document.master.geometry.nodes[node.id].p.x!==Math.round((node.p.x+2)*64)/64)throw Error('Undo did not restore second edit');
    await ask({type:'redo'});await ask({type:'flush'});const redone=await ask({type:'snapshot'});
    if(redone.document.master.geometry.nodes[node.id].p.x!==saved.document.master.geometry.nodes[node.id].p.x)throw Error('Redo failed');
    w.terminate();return {initMs,commitMs,totalSettleMs,settledCount,latestSequence:latest.editSequence,checks:['Consecutive node commits do not await pixel rendering','A pending save does not block the next node edit','Save waits for the latest exact geometry and pixels','Undo/redo after background settlement preserves the node']};
  },{document,profile:DEFAULT_PROFILE,node,worker});
  assert(Math.max(...result.commitMs)<1500,'Dense edit acknowledgement exceeded 1.5 seconds');
  await mkdir('output/editor-latency',{recursive:true});await writeFile('output/editor-latency/worker.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
