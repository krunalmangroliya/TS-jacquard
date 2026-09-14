import { describe,expect,it,vi } from 'vitest';
import { applyOperation,commit,createHistory,undo,redo,validateOperation,type Operation } from './ops';
import * as topology from './topology';
import { DEFAULT_PALETTE,DEFAULT_PROFILE,type Master,type Vec2,type Edge } from './types';
import { validateMaster } from './schemas';
import { EditorEngine } from '../../../apps/web/src/editor.worker';
import type { DesignRecord } from '../../app-model/src/index';
import type { EditorReply,EditorState } from '../../../apps/web/src/editor-protocol';

function fixture():Master {
  const geometry:Master['geometry']={nodes:{},edges:{},faceColors:{}};
  for(const [id,x] of [['a',16],['b',80]] as const){const points=[{x,y:16},{x:x+32,y:16},{x:x+32,y:48},{x,y:48}];points.forEach((p,i)=>{geometry.nodes[`${id}${i}`]={id:`${id}${i}`,p,kind:'corner'};});geometry.edges[id]={id,nodeIds:[`${id}0`,`${id}1`,`${id}2`,`${id}3`,`${id}0`],segments:[{},{},{},{}],width:id==='a'?3:2,widthMode:id==='a'?'design':'output',colorIndex:5,z:0};}
  const master:Master={schemaVersion:1,id:'m',workspaceId:'w',name:'Original',tags:[],createdAt:'created',updatedAt:'old',bounds:{w:256,h:128},repeat:{type:'none'},palette:structuredClone(DEFAULT_PALETTE),geometry,objects:['a','b'].map(id=>({id,name:id,edgeIds:[id],hidden:false,locked:false})),source:{fileId:'source',widthPx:256,heightPx:128},traceParams:{threshold:'otsu',invert:false,minSpeckArea:0,gapClosePx:0,spurPrunePx:0,simplifyTolerance:1,fitMaxError:1.5,cornerAngleDeg:60},version:1};
  const faces=topology.buildPlanarMap(geometry,master.bounds,master.repeat).faces;for(const face of faces)geometry.faceColors[face.id]={colorIndex:!face.outer?0:face.ref.x<64?2:3,ref:face.ref};return validateMaster(master);
}
function record(kind:'master'|'size'='master'):DesignRecord{return {id:'d',kind,name:'Original',tags:[],master:fixture(),profileId:DEFAULT_PROFILE.id,sizeInput:{mode:'grid',widthPx:64,heightPx:32,linkAspect:false},rules:{minRegionPx:0,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false},pixelOverrides:[],operations:[],revision:3,createdAt:'created',updatedAt:'old'};}
function state(reply:EditorReply):EditorState {expect(['ready','state']).toContain(reply.type);if(reply.type!=='ready'&&reply.type!=='state')throw new Error(JSON.stringify(reply));return reply;}
function cubic(edge:Edge,master:Master,i:number,t:number):Vec2 {const a=master.geometry.nodes[edge.nodeIds[i]].p,d=master.geometry.nodes[edge.nodeIds[i+1]].p,c=edge.segments[i],b=c.c1??a,e=c.c2??d,u=1-t;return{x:a.x*u**3+3*b.x*u*u*t+3*e.x*u*t*t+d.x*t**3,y:a.y*u**3+3*b.y*u*u*t+3*e.y*u*t*t+d.y*t**3};}

describe('expanded geometry and ownership operations',()=>{
  it('adds snapped edges to an existing object and preserves existing anchors',()=>{
    const master=fixture(),before=JSON.stringify(master);
    const result=applyOperation(master,{t:'addEdge',edge:{id:'new',nodeIds:['a0','new-node'],segments:[{c1:{x:20.012,y:24.023},c2:{x:35.034,y:44.045}}],width:2,widthMode:'design',colorIndex:5,z:0},nodes:[{id:'new-node',p:{x:60.012,y:66.023},kind:'corner'}],objectId:'a'}).master;
    expect(result.objects.find(o=>o.id==='a')!.edgeIds).toEqual(['a','new']);expect(result.geometry.nodes['new-node'].p).toEqual({x:60.015625,y:66.015625});expect(result.geometry.nodes.a0).toEqual(master.geometry.nodes.a0);expect(JSON.stringify(master)).toBe(before);
  });
  it('splits a cubic with De Casteljau while retaining its shape to the fixed-point precision',()=>{
    const master=fixture();master.geometry.edges.a.segments[0]={c1:{x:22,y:0},c2:{x:40,y:70}};
    const result=applyOperation(master,{t:'insertNode',edgeId:'a',segIndex:0,tParam:0.37,nodeId:'inserted'}).master,edge=result.geometry.edges.a;
    expect(edge.nodeIds.slice(0,3)).toEqual(['a0','inserted','a1']);expect(result.geometry.nodes.inserted.kind).toBe('smooth');
    for(let i=0;i<=30;i++){const t=i/30,original=cubic(master.geometry.edges.a,master,0,t),next=t<=0.37?cubic(edge,result,0,t/0.37):cubic(edge,result,1,(t-0.37)/0.63);expect(Math.hypot(original.x-next.x,original.y-next.y)).toBeLessThan(0.02);}
    expect(()=>applyOperation(master,{t:'insertNode',edgeId:'a',segIndex:0,tParam:0,nodeId:'bad'})).toThrow();
  });
  it('keeps smooth opposite handles collinear and replaces both control values explicitly',()=>{
    let master=fixture();master.geometry.edges.a.segments[0]={c1:{x:20,y:20},c2:{x:44,y:10}};master.geometry.edges.a.segments[1]={c1:{x:50,y:25}};
    master=applyOperation(master,{t:'setNodeKind',nodeId:'a1',kind:'smooth'}).master;
    master=applyOperation(master,{t:'setControls',edgeId:'a',segIndex:0,c2:{x:44,y:12}}).master;
    const at=master.geometry.nodes.a1.p,left=master.geometry.edges.a.segments[0].c2!,right=master.geometry.edges.a.segments[1].c1!;
    expect(master.geometry.edges.a.segments[0].c1).toBeUndefined();expect(Math.abs((left.x-at.x)*(right.y-at.y)-(left.y-at.y)*(right.x-at.x))).toBeLessThan(0.05);expect((left.x-at.x)*(right.x-at.x)+(left.y-at.y)*(right.y-at.y)).toBeLessThan(0);
  });
  it('deletes interior and closure nodes with valid chains and exact undo/redo',()=>{
    const master=fixture(),history=commit(createHistory(master),{t:'deleteNode',edgeId:'a',nodeId:'a1'});
    expect(history.current.geometry.edges.a.nodeIds).toEqual(['a0','a2','a3','a0']);expect(history.current.geometry.nodes.a1).toBeUndefined();expect(history.past[0].warnings.join(' ')).toMatch(/approximated/);expect(undo(history).current).toEqual(master);expect(redo(undo(history)).current).toEqual(history.current);
    const closure=applyOperation(master,{t:'deleteNode',edgeId:'a',nodeId:'a0'}).master;expect(closure.geometry.edges.a.nodeIds).toEqual(['a1','a2','a3','a1']);expect(closure.geometry.edges.a.segments).toHaveLength(3);
  });
  it('groups and ungroups disconnected motifs without changing geometry or losing ownership',()=>{
    const master=fixture(),grouped=applyOperation(master,{t:'group',objectIds:['a','b'],resultId:'group',name:'Pair'}).master;
    expect(grouped.objects).toHaveLength(1);expect(grouped.geometry).toEqual(master.geometry);
    const ungrouped=applyOperation(grouped,{t:'ungroup',objectId:'group'}).master;expect(ungrouped.objects).toHaveLength(2);expect(ungrouped.objects.flatMap(o=>o.edgeIds).sort()).toEqual(['a','b']);expect(ungrouped.geometry).toEqual(master.geometry);
  });
  it('duplicates translated nodes, controls and face colors with deterministic IDs',()=>{
    const master=fixture(),operation:Operation={t:'duplicateObjects',objectIds:['a','b'],offset:{x:0,y:64},idPrefix:'copy'};
    const result=applyOperation(master,operation);expect(result.master.objects).toHaveLength(4);expect(result.master.geometry.nodes['copy-node-a0'].p).toEqual({x:16,y:80});expect(result.master.geometry.edges['copy-edge-a'].width).toBe(3);
    for(const [p,color] of [[{x:30,y:30},2],[{x:30,y:94},2],[{x:94,y:94},3]] as const){const face=topology.faceAt(result.faces!,p)!;expect(result.master.geometry.faceColors[face.id].colorIndex).toBe(color);}
    expect(result.master).toEqual(applyOperation(master,operation).master);expect(()=>applyOperation(result.master,operation)).toThrow(/collision/);
  });
  it('deletes selected objects and only their orphan nodes',()=>{
    const master=fixture(),result=applyOperation(master,{t:'deleteObjects',objectIds:['a']}).master;expect(result.objects.map(o=>o.id)).toEqual(['b']);expect(Object.keys(result.geometry.nodes).sort()).toEqual(['b0','b1','b2','b3']);expect(result.geometry.edges.b).toEqual(master.geometry.edges.b);
  });
  it('scales source widths for uniform transforms and warns about a nonuniform approximation',()=>{
    const master=fixture(),uniform=applyOperation(master,{t:'transformObjects',objectIds:['a','b'],matrix:[2,0,0,2,0,0]});expect(uniform.master.geometry.edges.a.width).toBe(6);expect(uniform.master.geometry.edges.b.width).toBe(2);
    const nonuniform=applyOperation(master,{t:'transformObjects',objectIds:['a'],matrix:[2,0,0,1,0,0]});expect(nonuniform.master.geometry.edges.a.width).toBeCloseTo(3*Math.SQRT2,1);expect(nonuniform.warnings.join(' ')).toMatch(/Nonuniform/);
  });
  it('checks locks before every newly supported object/node mutation',()=>{
    const master=fixture();master.objects[0].locked=true;const before=JSON.stringify(master);
    const operations:Operation[]=[{t:'setNodeKind',nodeId:'a0',kind:'smooth'},{t:'setControls',edgeId:'a',segIndex:0,c1:{x:20,y:20}},{t:'insertNode',edgeId:'a',segIndex:0,tParam:0.5,nodeId:'new'},{t:'deleteNode',edgeId:'a',nodeId:'a0'},{t:'group',objectIds:['a'],resultId:'group'},{t:'ungroup',objectId:'a'},{t:'duplicateObjects',objectIds:['a'],offset:{x:0,y:64},idPrefix:'copy'},{t:'deleteObjects',objectIds:['a']},{t:'renameObject',objectId:'a',name:'Changed'}];
    for(const operation of operations)expect(()=>applyOperation(master,operation)).toThrow(/locked/);expect(JSON.stringify(master)).toBe(before);
  });
  it('merges palette indices consistently across fills and strokes and keeps ground index zero',()=>{
    const master=fixture(),result=applyOperation(master,{t:'mergePalette',sourceIndex:2,targetIndex:4}).master;expect(result.palette.entries.map(e=>e.index)).toEqual([0,1,2,3,4]);expect(result.geometry.edges.a.colorIndex).toBe(4);
    const face=topology.faceAt(topology.buildPlanarMap(result.geometry,result.bounds,result.repeat).faces,{x:30,y:30})!;expect(result.geometry.faceColors[face.id].colorIndex).toBe(3);expect(()=>applyOperation(master,{t:'mergePalette',sourceIndex:0,targetIndex:1})).toThrow();
  });
  it('uses cached faces and structural sharing for repeated fill and style edits',()=>{
    const master=fixture(),faces=topology.buildPlanarMap(master.geometry,master.bounds,master.repeat).faces,face=topology.faceAt(faces,{x:30,y:30})!,spy=vi.spyOn(topology,'buildPlanarMap');
    try{const result=applyOperation(master,{t:'setFaceColor',faceId:face.id,ref:face.ref,colorIndex:4},{faces,assumeValidated:true});expect(spy).not.toHaveBeenCalled();expect(result.master.geometry.nodes).toBe(master.geometry.nodes);expect(result.master.geometry.edges).toBe(master.geometry.edges);expect(result.master.geometry.faceColors[face.id].colorIndex).toBe(4);}finally{spy.mockRestore();}
  });
  it('validates every serialized operation variant and rejects malformed history payloads',()=>{
    expect(validateOperation({t:'renameObject',objectId:'a',name:'Petal'})).toEqual({t:'renameObject',objectId:'a',name:'Petal'});
    for(const invalid of [{t:'unknown'},{t:'insertNode',edgeId:'a',segIndex:0,tParam:1,nodeId:'n'},{t:'moveNodes',nodes:[{id:'a0',to:{x:Infinity,y:0}}]},{t:'mergePalette',sourceIndex:0,targetIndex:2}])expect(()=>validateOperation(invalid)).toThrow();
  });
});

describe('editor worker state, cache and compact history',()=>{
  it('fills cached geometry without rebuilding topology and exposes stable preview data',()=>{
    const engine=new EditorEngine(),ready=state(engine.handle({type:'init',requestId:1,document:record(),profile:DEFAULT_PROFILE,previewWidth:64}));expect(ready.geometry).toBeDefined();expect(ready.render.widthPx).toBe(64);
    const face=topology.faceAt(ready.geometry!.faces,{x:30,y:30})!,spy=vi.spyOn(topology,'buildPlanarMap');
    try{const changed=state(engine.handle({type:'action',requestId:2,action:{type:'operation',operation:{t:'setFaceColor',faceId:face.id,ref:face.ref,colorIndex:4}}}));expect(spy).not.toHaveBeenCalled();expect(changed.geometry).toBeUndefined();expect(changed.document.operations).toHaveLength(1);expect(changed.editSequence).toBe(1);expect(changed.document.master.geometry.faceColors[face.id].colorIndex).toBe(4);}finally{spy.mockRestore();}
  });
  it('keeps authoritative save acknowledgements through metadata undo and redo',()=>{
    const engine=new EditorEngine();engine.handle({type:'init',requestId:1,document:record(),profile:DEFAULT_PROFILE,previewWidth:64});state(engine.handle({type:'action',requestId:2,action:{type:'metadata',name:'Edited',tags:['leaf']}}));expect(engine.handle({type:'ack',requestId:3,revision:4,version:2,updatedAt:'saved'}).type).toBe('ack');
    const previous=state(engine.handle({type:'undo',requestId:4}));expect(previous.document).toMatchObject({name:'Original',revision:4,updatedAt:'saved',master:{name:'Original',version:2,updatedAt:'saved'}});
    const next=state(engine.handle({type:'redo',requestId:5}));expect(next.document).toMatchObject({name:'Edited',revision:4,master:{version:2}});
  });
  it('rejects master pixel edits without losing the last good state',()=>{
    const engine=new EditorEngine(),initial=record();engine.handle({type:'init',requestId:1,document:initial,profile:DEFAULT_PROFILE,previewWidth:64});expect(engine.handle({type:'action',requestId:2,action:{type:'pixels',pixels:[{x:1,y:1,colorIndex:4}]}}).type).toBe('error');
    const snapshot=engine.handle({type:'snapshot',requestId:3});expect(snapshot.type).toBe('snapshot');if(snapshot.type==='snapshot')expect(snapshot.document.pixelOverrides).toEqual([]);expect(state(engine.handle({type:'render',requestId:4})).canUndo).toBe(false);
  });
  it('applies size pixels last, restores them through undo, and exports exact dimensions',()=>{
    const engine=new EditorEngine();engine.handle({type:'init',requestId:1,document:record('size'),profile:DEFAULT_PROFILE});const changed=state(engine.handle({type:'action',requestId:2,action:{type:'pixels',pixels:[{x:63,y:31,colorIndex:4}]}}));expect(changed.render.grid[31*64+63]).toBe(4);expect(changed.render.preview).toBe(false);
    expect(state(engine.handle({type:'undo',requestId:3})).document.pixelOverrides).toEqual([]);expect(state(engine.handle({type:'redo',requestId:4})).document.pixelOverrides).toEqual([{x:63,y:31,colorIndex:4}]);
    const exported=engine.handle({type:'export',requestId:5,format:'bmp'});expect(exported.type).toBe('export');if(exported.type==='export'){expect([...exported.bytes.slice(0,2)]).toEqual([66,77]);expect(new DataView(exported.bytes.buffer,exported.bytes.byteOffset,exported.bytes.byteLength).getInt32(18,true)).toBe(64);}
  });
  it('remaps palette-dependent pixel overrides and protected colors atomically',()=>{
    const document=record('size');document.pixelOverrides=[{x:1,y:1,colorIndex:5}];document.rules.protectedColorIndices=[2,5];const engine=new EditorEngine();engine.handle({type:'init',requestId:1,document,profile:DEFAULT_PROFILE});
    const changed=state(engine.handle({type:'action',requestId:2,action:{type:'operation',operation:{t:'mergePalette',sourceIndex:2,targetIndex:4}}}));expect(changed.document.pixelOverrides[0].colorIndex).toBe(4);expect(changed.document.rules.protectedColorIndices).toEqual([3,4]);expect(changed.document.master.palette.entries).toHaveLength(5);
    const previous=state(engine.handle({type:'undo',requestId:3}));expect(previous.document.pixelOverrides[0].colorIndex).toBe(5);expect(previous.document.rules.protectedColorIndices).toEqual([2,5]);expect(previous.document.operations).toEqual([]);
  });
  it('restores size and profile selection after a resize with clipped overrides',()=>{
    const document=record('size');document.pixelOverrides=[{x:63,y:31,colorIndex:4}];const engine=new EditorEngine();engine.handle({type:'init',requestId:1,document,profile:DEFAULT_PROFILE});const profile={...DEFAULT_PROFILE,id:'other',epi:120,ppi:96};
    const changed=state(engine.handle({type:'action',requestId:2,profile,action:{type:'size',profileId:'other',sizeInput:{mode:'grid',widthPx:32,heightPx:16,linkAspect:false}}}));expect(changed.document.pixelOverrides).toEqual([]);expect(changed.render.epi).toBe(120);
    const previous=state(engine.handle({type:'undo',requestId:3}));expect(previous.document.pixelOverrides).toHaveLength(1);expect(previous.render.widthPx).toBe(64);expect(previous.render.epi).toBe(DEFAULT_PROFILE.epi);
  });
  it('refreshes visible topology when grouping changes hidden edge membership and restores it on undo',()=>{
    const document=record();document.master.objects[1].hidden=true;const engine=new EditorEngine();
    const initial=state(engine.handle({type:'init',requestId:1,document,profile:DEFAULT_PROFILE,previewWidth:64}));expect(initial.stats.faces).toBe(1);
    const grouped=state(engine.handle({type:'action',requestId:2,action:{type:'operation',operation:{t:'group',objectIds:['a','b'],resultId:'pair'}}}));expect(grouped.geometry).toBeDefined();expect(grouped.stats.faces).toBe(2);
    const previous=state(engine.handle({type:'undo',requestId:3}));expect(previous.geometry).toBeDefined();expect(previous.stats.faces).toBe(1);expect(previous.document.master.objects[1].hidden).toBe(true);
  });
  it('clears cached visible fill colors with hidden objects without rebuilding topology',()=>{
    const document=record();document.master.objects[1].hidden=true;const engine=new EditorEngine();
    const initial=state(engine.handle({type:'init',requestId:1,document,profile:DEFAULT_PROFILE,previewWidth:64})),ground=topology.faceAt(initial.geometry!.faces,{x:200,y:100})!,spy=vi.spyOn(topology,'buildPlanarMap');
    try{state(engine.handle({type:'action',requestId:2,action:{type:'operation',operation:{t:'setFaceColor',faceId:ground.id,ref:ground.ref,colorIndex:null}}}));expect(spy).not.toHaveBeenCalled();const selected=engine.handle({type:'hitFace',requestId:3,point:{x:200,y:100}});expect(selected.type).toBe('hitFace');if(selected.type==='hitFace')expect(selected.colorIndex).toBeNull();}finally{spy.mockRestore();}
  });
  it('rejects stale requests and leaves the operation log unchanged after failed edits',()=>{
    const engine=new EditorEngine();engine.handle({type:'init',requestId:1,document:record(),profile:DEFAULT_PROFILE,previewWidth:64});expect(engine.handle({type:'action',requestId:2,action:{type:'operation',operation:{t:'deleteEdge',edgeId:'missing'}}}).type).toBe('error');expect(engine.handle({type:'snapshot',requestId:2}).type).toBe('error');const snapshot=engine.handle({type:'snapshot',requestId:3});if(snapshot.type==='snapshot')expect(snapshot.document.operations).toEqual([]);
  });
});
