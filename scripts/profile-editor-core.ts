import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {EditorEngine} from '../apps/web/src/editor.worker';
import {DEFAULT_PROFILE,type Master} from '../packages/core/src/types';
import type {DesignRecord} from '../packages/app-model/src/index';
import {buildPlanarMap,resolveFaceColors,trackFaces} from '../packages/core/src/topology';
import {validateMaster} from '../packages/core/src/schemas';
import {applyOperation} from '../packages/core/src/ops';
import {render} from '../packages/core/src/render';

const label=process.argv[2]??'current',path=process.argv[3]??'output/stroke-trial/sample-1-bb1795/master.json';
const master=JSON.parse(await readFile(path,'utf8')) as Master;
const timings:Record<string,number[]>={};
function measure<T>(name:string,fn:()=>T):T {const start=performance.now();const result=fn();(timings[name]??=[]).push(Math.round((performance.now()-start)*100)/100);return result;}
const rules={minRegionPx:0,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false};
const document:DesignRecord={id:'core-perf',kind:'master',name:master.name,tags:[],master,profileId:DEFAULT_PROFILE.id,sizeInput:{mode:'grid',widthPx:1200,linkAspect:true},rules,pixelOverrides:[],operations:[],revision:1,createdAt:master.createdAt,updatedAt:master.updatedAt};
const node=Object.values(master.geometry.nodes).sort((a,b)=>Math.hypot(a.p.x-master.bounds.w/2,a.p.y-master.bounds.h/2)-Math.hypot(b.p.x-master.bounds.w/2,b.p.y-master.bounds.h/2))[0];
const operation={t:'moveNodes' as const,nodes:[{id:node.id,to:{x:node.p.x+1,y:node.p.y+0.5}}]};
for(let i=0;i<6;i++)measure('core.moveNodes.deferred',()=>applyOperation(master,operation,{assumeValidated:true,deferTopology:true}));
if(process.argv.includes('--deferred-only')){console.log(JSON.stringify(timings,null,2));process.exit(0);}
const engine=new EditorEngine();
for(const key of ['validateDocument','prepareGeometry','refreshAppearance','rasterize','state','action']){
 const target=engine as unknown as Record<string,(...args:unknown[])=>unknown>,original=target[key];
 if(original)target[key]=function(...args:unknown[]){return measure('engine.'+key,()=>original.apply(engine,args));};
}
const ready=measure('engine.init',()=>engine.handle({type:'init',requestId:1,document,profile:DEFAULT_PROFILE,previewWidth:1200}));
if(ready.type==='error')throw new Error(ready.message);console.log('Engine init',timings['engine.init']);
const moved=measure('engine.moveNodes',()=>engine.handle({type:'action',requestId:2,action:{type:'operation',operation}}));
if(moved.type==='error')throw new Error(moved.message);console.log('Engine move',timings['engine.moveNodes']);
const fast=measure('engine.moveNodes.interactive',()=>engine.handleInteractive({type:'action',requestId:3,action:{type:'operation',operation:{t:'moveNodes',nodes:[{id:node.id,to:{x:node.p.x+2,y:node.p.y+1}}]}}}));
if(fast.type==='error')throw new Error(fast.message);console.log('Interactive commit',timings['engine.moveNodes.interactive']);
const validated=measure('core.validateMaster',()=>validateMaster(master));
const topology=measure('core.buildPlanarMap',()=>buildPlanarMap(validated.geometry,validated.bounds,validated.repeat));
const colors=measure('core.resolveFaceColors',()=>resolveFaceColors(topology.faces,validated.geometry.faceColors));validated.geometry.faceColors=colors.faceColors;
const updated=measure('core.applyOperation.cached',()=>applyOperation(validated,operation,{assumeValidated:true,faces:topology.faces}));
measure('core.trackFaces.identical',()=>trackFaces(topology.faces,colors.faceColors,topology.faces));
const height=Math.round(1200*master.bounds.h/master.bounds.w);
const raster=measure('core.render',()=>render(updated.master.geometry,updated.faces!,master.bounds,master.palette,1200,height,rules,[],master.repeat));
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const result={label,path,counts:{nodes:Object.keys(master.geometry.nodes).length,edges:Object.keys(master.geometry.edges).length,faces:topology.faces.length,objects:master.objects.length},operation,timings,hashes:{geometry:digest(updated.master.geometry),faces:digest(updated.faces),grid:createHash('sha256').update(raster.grid).digest('hex'),report:digest(raster.report)}};
await mkdir('output/core-perf',{recursive:true});await writeFile(`output/core-perf/${label}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
