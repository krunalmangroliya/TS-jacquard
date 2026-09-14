import {describe,it,expect} from 'vitest';
import {EditorEngine} from './editor-engine';
import {settle} from './settle.worker';
import type {EditorRequest,EditorState} from './editor-protocol';
import type {DesignRecord,EditorAction} from '../../../packages/app-model/src/index';
import {DEFAULT_PALETTE,DEFAULT_PROFILE,type Master} from '../../../packages/core/src/types';
import {buildPlanarMap,faceAt} from '../../../packages/core/src/topology';
import type {Operation} from '../../../packages/core/src/ops';

function fixture():DesignRecord {
 const geometry:Master['geometry']={nodes:{},edges:{},faceColors:{}};
 for(const [id,x,y] of [['a',16,16],['b',112,16],['c',112,80],['d',16,80],['top',64,16],['bottom',64,80]] as const)geometry.nodes[id]={id,p:{x,y},kind:'corner'};
 geometry.edges.outline={id:'outline',nodeIds:['a','b','c','d','a'],segments:[{},{},{},{}],width:2,widthMode:'design',colorIndex:5,z:0};
 geometry.edges.divider={id:'divider',nodeIds:['top','bottom'],segments:[{}],width:1,widthMode:'design',colorIndex:5,z:0};
 const master:Master={schemaVersion:1,id:'master',workspaceId:'test',name:'Divided motif',tags:[],createdAt:'created',updatedAt:'old',bounds:{w:128,h:96},repeat:{type:'none'},palette:structuredClone(DEFAULT_PALETTE),geometry,objects:['outline','divider'].map(id=>({id,name:id,edgeIds:[id],locked:false,hidden:false})),source:{fileId:'source',widthPx:128,heightPx:96},traceParams:{threshold:'otsu',invert:false,minSpeckArea:0,gapClosePx:0,spurPrunePx:0,simplifyTolerance:1,fitMaxError:1.5,cornerAngleDeg:60},version:1};
 for(const face of buildPlanarMap(geometry,master.bounds,master.repeat).faces)geometry.faceColors[face.id]={ref:face.ref,colorIndex:face.outer?face.ref.x<64?2:3:0};
 return {id:'variant',kind:'size',masterId:'master',baseMasterVersion:1,name:'Small motif',tags:[],master,revision:1,createdAt:'created',updatedAt:'old',profileId:DEFAULT_PROFILE.id,sizeInput:{mode:'grid',widthPx:128,heightPx:96,linkAspect:false},rules:{minRegionPx:0,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false},pixelOverrides:[],operations:[]};
}
function pair(){
 const sync=new EditorEngine(),interactive=new EditorEngine();let requestId=0,last:EditorState;
 const init:EditorRequest={type:'init',requestId:++requestId,document:fixture(),profile:DEFAULT_PROFILE,previewWidth:128};last=sync.handle(init) as EditorState;interactive.handle(init);
 function send(request:Omit<EditorRequest,'requestId'>|Record<string,unknown>){const message={...request,requestId:++requestId} as EditorRequest;const a=sync.handle(message),b=interactive.handleInteractive(message);expect(a.type).not.toBe('error');expect(b.type).not.toBe('error');if(a.type==='state'||a.type==='ready')last=a;return {a,b};}
 function action(action:EditorAction){return send({type:'action',action});}
 function settled(){const result=settle(interactive.settlementInput());interactive.acceptDerived(result.state,result.cache);return result.state;}
 function same(){const current=settled();expect(current.document).toEqual(last.document);expect(current.render.grid).toEqual(last.render.grid);expect(current.render.report).toEqual(last.render.report);return current;}
 return {sync,interactive,send,action,settled,same,get state(){return last;}};
}
describe('interactive commit and exact background settlement',()=>{
 it('commits two moves before settlement and matches synchronous pixels and assignments',()=>{
  const p=pair();for(const [id,to] of [['a',{x:18,y:17}],['d',{x:18,y:79}]] as const){const reply=p.action({type:'operation',operation:{t:'moveNodes',nodes:[{id,to}]}});expect(reply.b.type).toBe('committed');expect(p.interactive.isTopologyPending).toBe(true);}p.same();expect(p.interactive.isTopologyPending).toBe(false);
 });
 it('settles changed cubic handles exactly like the synchronous engine',()=>{
  const p=pair();p.action({type:'operation',operation:{t:'setControls',edgeId:'outline',segIndex:3,c1:{x:12,y:60},c2:{x:12,y:30}}});p.same();
 });
 it('undoes and redoes edits before the first settlement',()=>{
  const p=pair();p.action({type:'operation',operation:{t:'moveNodes',nodes:[{id:'a',to:{x:18,y:17}}]}});p.send({type:'undo'});p.same();p.send({type:'redo'});p.same();
 });
 it('restores original split colors when undoing a settled face merge',()=>{
  const p=pair();p.action({type:'operation',operation:{t:'moveNodes',nodes:[{id:'top',to:{x:64,y:24}}]}});p.same();expect(p.state.stats.faces).toBe(1);p.send({type:'undo'});p.same();expect(p.state.stats.faces).toBe(2);p.send({type:'redo'});p.same();
 });
 it('retains new fills through later deferred movement and undo/redo',()=>{
  const p=pair();p.action({type:'operation',operation:{t:'moveNodes',nodes:[{id:'d',to:{x:14,y:80}}]}});p.same();const face=faceAt(p.state.geometry?.faces??p.sync.derivedCache().fullFaces,{x:32,y:40})!;
  p.action({type:'operation',operation:{t:'setFaceColor',faceId:face.id,ref:face.ref,colorIndex:4}});p.same();p.action({type:'operation',operation:{t:'moveNodes',nodes:[{id:'a',to:{x:14,y:16}}]}});p.same();p.send({type:'undo'});p.same();p.send({type:'redo'});p.same();
 });
 it('preserves acknowledgement metadata, snapshots and exact exported BMP bytes',()=>{
  const p=pair();p.action({type:'operation',operation:{t:'moveNodes',nodes:[{id:'d',to:{x:14,y:80}}]}});p.same();p.send({type:'ack',revision:9,version:4,updatedAt:'saved'});p.send({type:'undo'});p.same();
  const snapshot=p.send({type:'snapshot'});expect(snapshot.a).toEqual(snapshot.b);if(snapshot.b.type==='snapshot')expect(snapshot.b.document).toMatchObject({revision:9,updatedAt:'saved',master:{version:4}});
  const exported=p.send({type:'export',format:'bmp'});expect(exported.a.type).toBe('export');expect(exported.b.type).toBe('export');if(exported.a.type==='export'&&exported.b.type==='export')expect(exported.b.bytes).toEqual(exported.a.bytes);
 });
 it.each([{t:'deleteEdge',edgeId:'divider'},{t:'deleteObjects',objectIds:['divider']},{t:'addEdge',objectId:'outline',edge:{id:'crossbar',nodeIds:['left','right'],segments:[{}],width:2,widthMode:'design',colorIndex:5,z:0},nodes:[{id:'left',p:{x:16,y:48},kind:'corner'},{id:'right',p:{x:112,y:48},kind:'corner'}]}] as Operation[])('settles $t then undo/redo with the synchronous fill assignments',operation=>{
  const p=pair();p.action({type:'operation',operation});expect(p.interactive.isTopologyPending).toBe(true);p.same();p.send({type:'undo'});p.same();p.send({type:'redo'});p.same();
 });
 it('keeps merge undo/redo colors when a stroke edit arrives before settlement',()=>{
  const p=pair();p.action({type:'operation',operation:{t:'moveNodes',nodes:[{id:'top',to:{x:64,y:24}}]}});p.action({type:'operation',operation:{t:'setEdgeStyle',edgeId:'outline',width:3,widthMode:'design',colorIndex:4}});p.same();
  p.send({type:'undo'});p.same();p.send({type:'undo'});p.same();p.send({type:'redo'});p.same();p.send({type:'redo'});p.same();
 });
 it('requires the host settlement barrier before merging palette indices, preserving undo colors',()=>{
  const p=pair();p.action({type:'operation',operation:{t:'moveNodes',nodes:[{id:'top',to:{x:64,y:24}}]}});
  const standalone=new EditorEngine();standalone.handle({type:'init',requestId:1,document:fixture(),profile:DEFAULT_PROFILE,previewWidth:128});standalone.handleInteractive({type:'action',requestId:2,action:{type:'operation',operation:{t:'moveNodes',nodes:[{id:'top',to:{x:64,y:24}}]}}});
  const before=structuredClone(standalone.settlementInput().document);
  expect(standalone.handleInteractive({type:'action',requestId:3,action:{type:'operation',operation:{t:'mergePalette',sourceIndex:3,targetIndex:2}}})).toMatchObject({type:'error',message:'Finish pending geometry before merging palette colors'});expect(standalone.settlementInput().document).toEqual(before);
  p.same();p.action({type:'operation',operation:{t:'mergePalette',sourceIndex:3,targetIndex:2}});p.same();
  p.send({type:'undo'});p.same();p.send({type:'undo'});p.same();p.send({type:'redo'});p.same();p.send({type:'redo'});p.same();
 });
 it('keeps operation and topology warnings in the settled state and later render',()=>{
  const p=pair();const commit=p.action({type:'operation',operation:{t:'deleteNode',edgeId:'outline',nodeId:'a'}}).b;
  expect(commit.type).toBe('committed');const current=p.settled();if(commit.type==='committed')for(const warning of commit.warnings)expect(current.warnings).toContain(warning);
  for(const warning of p.state.warnings)expect(current.warnings).toContain(warning);
  const again=p.settled();expect(again.warnings).toEqual(current.warnings);expect(current.warnings.some(warning=>warning.includes('approximated'))).toBe(true);
 });
 it('reads the latest committed face color before a raster settlement',()=>{
  const p=pair(),face=faceAt(p.interactive.derivedCache().fullFaces,{x:32,y:40})!;
  p.action({type:'operation',operation:{t:'setFaceColor',faceId:face.id,ref:face.ref,colorIndex:4}});expect(p.interactive.isTopologyPending).toBe(false);
  const hit=p.send({type:'hitFace',point:{x:32,y:40}});expect(hit.a).toEqual(hit.b);expect(hit.b).toMatchObject({type:'hitFace',colorIndex:4});
 });
});
