import {describe,it,expect} from 'vitest';
import {EditorEngine} from './editor-engine';
import {applyEditorPatch,getOptimisticPatch,primeEditorPatchKeys} from './editor-patch';
import {settle} from './settle.worker';
import {applyOperation,type Operation} from '../../../packages/core/src/ops';
import {DEFAULT_PALETTE,DEFAULT_PROFILE,type Master} from '../../../packages/core/src/types';
import {buildPlanarMap} from '../../../packages/core/src/topology';
import type {DesignRecord,EditorAction} from '../../../packages/app-model/src/index';

function fixture():DesignRecord {
 const geometry:Master['geometry']={nodes:{},edges:{},faceColors:{}};
 for(const [id,x] of [['a',16],['b',96]] as const){const points=[{x,y:16},{x:x+48,y:16},{x:x+48,y:64},{x,y:64}];points.forEach((p,i)=>geometry.nodes[id+i]={id:id+i,p,kind:'corner'});geometry.edges[id]={id,nodeIds:[id+'0',id+'1',id+'2',id+'3',id+'0'],segments:[{c1:{x:x+12,y:4},c2:{x:x+40,y:8}},{c1:{x:x+52,y:32}},{},{}],width:3,widthMode:'design',colorIndex:5,z:0};}
 const master:Master={schemaVersion:1,id:'m',workspaceId:'w',name:'Patched edit',tags:[],createdAt:'created',updatedAt:'old',bounds:{w:192,h:96},repeat:{type:'none'},palette:structuredClone(DEFAULT_PALETTE),geometry,objects:['a','b'].map(id=>({id,name:id,edgeIds:[id],locked:false,hidden:false})),source:{fileId:'source',widthPx:192,heightPx:96},traceParams:{threshold:'otsu',invert:false,minSpeckArea:0,gapClosePx:0,spurPrunePx:0,simplifyTolerance:1,fitMaxError:1.5,cornerAngleDeg:60},version:1};
 for(const face of buildPlanarMap(geometry,master.bounds,master.repeat).faces)geometry.faceColors[face.id]={ref:face.ref,colorIndex:face.outer?face.ref.x<80?2:3:0};
 return {id:'record',kind:'master',name:master.name,tags:[],master,revision:1,createdAt:'created',updatedAt:'old',profileId:DEFAULT_PROFILE.id,sizeInput:{mode:'grid',widthPx:192,heightPx:96,linkAspect:false},rules:{minRegionPx:0,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false},pixelOverrides:[],operations:[]};
}

describe('sparse worker commit application',()=>{
 it('transmits only changed values and preserves all unaffected identities',async()=>{
  const engine=new EditorEngine(),source=fixture();engine.handle({type:'init',requestId:1,document:source,profile:DEFAULT_PROFILE,previewWidth:192});
  const before=structuredClone(source),reply=engine.handleInteractive({type:'action',requestId:2,action:{type:'operation',operation:{t:'moveNodes',nodes:[{id:'a1',to:{x:68.123,y:18.456}}]}}});
  expect(reply.type).toBe('committed');if(reply.type!=='committed')throw new Error('commit');
  expect('document' in reply).toBe(false);expect(Object.keys(reply.patch.nodes!)).toEqual(['a1']);expect(reply.patch.objects).toBeUndefined();expect(JSON.stringify(reply).length).toBeLessThan(3000);
  const next=await applyEditorPatch(source,reply.patch);expect(next).toEqual(engine.settlementInput().document);expect(source).toEqual(before);
  expect(next.master.geometry.nodes.b0).toBe(source.master.geometry.nodes.b0);expect(next.master.geometry.edges.b).toBe(source.master.geometry.edges.b);expect(next.master.objects).toBe(source.master.objects);expect(next.master.palette).toBe(source.master.palette);expect(next.master.geometry.faceColors).toBe(source.master.geometry.faceColors);
 });
 it('applies forward, undo and redo patches across topology settlement and metadata changes',async()=>{
  const engine=new EditorEngine();let requestId=1,document=fixture();const ready=engine.handle({type:'init',requestId,document,profile:DEFAULT_PROFILE,previewWidth:192});if(ready.type!=='ready')throw new Error('init');document=ready.document;
  async function send(request:{type:'action';action:EditorAction}|{type:'undo'|'redo'}){const reply=engine.handleInteractive({...request,requestId:++requestId});if(reply.type!=='committed')throw new Error(reply.type==='error'?reply.message:'commit');document=await applyEditorPatch(document,structuredClone(reply.patch));expect(document).toEqual(engine.settlementInput().document);}
  await send({type:'action',action:{type:'operation',operation:{t:'deleteEdge',edgeId:'a'}}});await send({type:'undo'});await send({type:'redo'});
  const derived=settle(engine.settlementInput());engine.acceptDerived(derived.state,derived.cache);document=derived.state.document;
  await send({type:'undo'});await send({type:'redo'});await send({type:'action',action:{type:'metadata',name:'Renamed',tags:['Gold']}});await send({type:'undo'});await send({type:'redo'});
  await send({type:'action',action:{type:'operation',operation:{t:'renameObject',objectId:'b',name:'Remaining motif'}}});await send({type:'undo'});await send({type:'redo'});
 });
 it('keeps acknowledged server metadata and deletes optional metadata without mutating snapshots',async()=>{
  const source=fixture();source.revision=9;source.updatedAt='saved';source.master.version=4;source.master.updatedAt='saved';source.baseMasterVersion=2;
  const next=await applyEditorPatch(source,{document:{name:'New',baseMasterVersion:null},master:{name:'New'}});
  expect(next).toMatchObject({revision:9,updatedAt:'saved',master:{version:4,updatedAt:'saved'}});expect(next.baseMasterVersion).toBeUndefined();expect(source.baseMasterVersion).toBe(2);
 });
 it('yields while copying a large changed node table and keeps its source immutable',async()=>{
  const source=fixture();for(let i=0;i<100_000;i++)source.master.geometry.nodes['extra'+i]={id:'extra'+i,p:{x:i,y:0},kind:'corner'};
  primeEditorPatchKeys(source);let inputProcessed=false;setTimeout(()=>{inputProcessed=true;},0);
  const replacement={...source.master.geometry.nodes.extra10,p:{x:12,y:5}},next=await applyEditorPatch(source,{nodes:{extra10:replacement,extra20:null,newNode:{id:'newNode',p:{x:1,y:2},kind:'corner'}}});
  expect(inputProcessed).toBe(true);expect(source.master.geometry.nodes.extra10.p.x).toBe(10);expect(source.master.geometry.nodes.extra20).toBeDefined();expect(next.master.geometry.nodes.extra20).toBeUndefined();expect(next.master.geometry.nodes.extra10).toBe(replacement);expect(next.master.geometry.nodes.extra11).toBe(source.master.geometry.nodes.extra11);
  expect(await applyEditorPatch(next,{})).toBe(next);
 });
});

describe('bounded optimistic patches',()=>{
 const operations:Operation[]=[{t:'moveNodes',nodes:[{id:'a1',to:{x:68.123,y:18.456}}]},{t:'setNodeKind',nodeId:'a1',kind:'smooth'},{t:'setControls',edgeId:'a',segIndex:0,c2:{x:61,y:9}},{t:'insertNode',edgeId:'a',segIndex:0,tParam:.43,nodeId:'inserted'},{t:'setEdgeStyle',edgeId:'a',width:5,widthMode:'design',colorIndex:4},{t:'setStrokeVisibility',edgeIds:['a'],hidden:true}];
 it.each(operations)('$t matches full core geometry using only the affected subgraph',async operation=>{
  const source=fixture(),before=structuredClone(source);source.master=applyOperation(source.master,{t:'setNodeKind',nodeId:'a1',kind:'smooth'}).master;
  const expected=applyOperation(source.master,operation,{assumeValidated:true,deferTopology:true}).master,patch=await getOptimisticPatch(source,{type:'operation',operation});expect(patch).toBeDefined();
  const actual=await applyEditorPatch(source,patch!);expect(actual.master.geometry.nodes).toEqual(expected.geometry.nodes);expect(actual.master.geometry.edges).toEqual(expected.geometry.edges);expect(source.master.geometry.nodes.b0).toEqual(before.master.geometry.nodes.b0);expect(actual.master.geometry.nodes.b0).toBe(source.master.geometry.nodes.b0);
 });
 it('checks global insert collisions and locks through shared-node incident edges',async()=>{
  const source=fixture();await expect(getOptimisticPatch(source,{type:'operation',operation:{t:'insertNode',edgeId:'a',segIndex:0,tParam:.5,nodeId:'b0'}})).rejects.toThrow(/already exists/);
  source.master.geometry.edges.b.nodeIds[0]='a1';source.master.objects[1].locked=true;
  await expect(getOptimisticPatch(source,{type:'operation',operation:{t:'moveNodes',nodes:[{id:'a1',to:{x:70,y:20}}]}})).rejects.toThrow(/locked/);
  await expect(getOptimisticPatch(source,{type:'operation',operation:{t:'setControls',edgeId:'a',segIndex:0,c2:{x:50,y:10}}})).rejects.toThrow(/locked/);
 });
 it('declines unsupported geometry without a full-master fallback',async()=>{
  const source=fixture();for(const operation of [{t:'deleteNode',edgeId:'a',nodeId:'a1'},{t:'transformObjects',objectIds:['a'],matrix:[1,0,0,1,1,1]}] as Operation[])expect(await getOptimisticPatch(source,{type:'operation',operation})).toBeUndefined();
 });
 it('updates fills and palette appearance while preserving the untouched geometry tables',async()=>{
  const source=fixture(),faces=buildPlanarMap(source.master.geometry,source.master.bounds,source.master.repeat).faces,face=faces.find(face=>face.outer)!;
  const operation:Operation={t:'setFaceColor',faceId:face.id,ref:face.ref,colorIndex:4},patch=await getOptimisticPatch(source,{type:'operation',operation},faces),filled=await applyEditorPatch(source,patch!);
  expect(filled.master).toEqual(applyOperation(source.master,operation,{assumeValidated:true,faces}).master);expect(filled.master.geometry.nodes).toBe(source.master.geometry.nodes);expect(filled.master.geometry.edges).toBe(source.master.geometry.edges);
  const palette=structuredClone(source.master.palette);palette.entries[4].displayRgb=[12,34,56];const recolored=await applyEditorPatch(filled,(await getOptimisticPatch(filled,{type:'operation',operation:{t:'setPalette',palette}}))!);
  expect(recolored.master.palette).toEqual(palette);expect(recolored.master.geometry).toBe(filled.master.geometry);
 });
});
