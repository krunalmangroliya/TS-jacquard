import {describe,it,expect,vi} from 'vitest';
import {applyOperation,DEFERRED_GEOMETRY_OPERATIONS,type Operation} from './ops';
import * as topology from './topology';
import {DEFAULT_PALETTE,type Master} from './types';
import {validateMaster} from './schemas';

function fixture():Master {
 const geometry:Master['geometry']={nodes:{},edges:{},faceColors:{}};
 for(const [id,x] of [['a',16],['b',96]] as const){const points=[{x,y:16},{x:x+48,y:16},{x:x+48,y:64},{x,y:64}];points.forEach((p,i)=>geometry.nodes[id+i]={id:id+i,p,kind:'corner'});geometry.edges[id]={id,nodeIds:[id+'0',id+'1',id+'2',id+'3',id+'0'],segments:[{c1:{x:x+12,y:4},c2:{x:x+40,y:8}},{c1:{x:x+52,y:32}},{},{}],width:3,widthMode:'design',colorIndex:5,z:0};}
 const master:Master={schemaVersion:1,id:'m',workspaceId:'w',name:'Deferred edit',tags:[],createdAt:'created',updatedAt:'old',bounds:{w:192,h:96},repeat:{type:'none'},palette:structuredClone(DEFAULT_PALETTE),geometry,objects:['a','b'].map(id=>({id,name:id,edgeIds:[id],locked:false,hidden:false})),source:{fileId:'source',widthPx:192,heightPx:96},traceParams:{threshold:'otsu',invert:false,minSpeckArea:0,gapClosePx:0,spurPrunePx:0,simplifyTolerance:1,fitMaxError:1.5,cornerAngleDeg:60},version:1};
 for(const face of topology.buildPlanarMap(geometry,master.bounds,master.repeat).faces)geometry.faceColors[face.id]={ref:face.ref,colorIndex:face.outer?face.ref.x<80?2:3:0};return validateMaster(master);
}
describe('deferred immutable node edits',()=>{
 const operations:Operation[]=[{t:'moveNodes',nodes:[{id:'a1',to:{x:67.234,y:18.456}}]},{t:'setControls',edgeId:'a',segIndex:0,c1:{x:30.123,y:6.456},c2:{x:57.789,y:12.345}},{t:'setNodeKind',nodeId:'a1',kind:'smooth'},{t:'insertNode',edgeId:'a',segIndex:0,tParam:0.43,nodeId:'inserted'},{t:'deleteNode',edgeId:'a',nodeId:'a1'}];
 it.each(operations)('$t settles to exactly the ordinary operation result',operation=>{
  const master=fixture(),before=structuredClone(master),faces=topology.buildPlanarMap(master.geometry,master.bounds,master.repeat).faces;
  const ordinary=applyOperation(master,operation,{faces}),spy=vi.spyOn(topology,'buildPlanarMap');let deferred;
  try{deferred=applyOperation(master,operation,{faces,assumeValidated:true,deferTopology:true});expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
  expect(deferred.geometryChanged).toBe(true);expect(deferred.faces).toBeUndefined();expect(deferred.master.geometry.faceColors).toBe(master.geometry.faceColors);
  expect(deferred.master.geometry.nodes.b0).toBe(master.geometry.nodes.b0);expect(deferred.master.geometry.edges.b).toBe(master.geometry.edges.b);
  const built=topology.buildPlanarMap(deferred.master.geometry,master.bounds,master.repeat),tracked=topology.trackFaces(faces,deferred.master.geometry.faceColors,built.faces);
  expect({...deferred.master,geometry:{...deferred.master.geometry,faceColors:tracked.faceColors}}).toEqual(ordinary.master);expect(tracked.faces).toEqual(ordinary.faces);expect(master).toEqual(before);
  const settled=applyOperation(master,operation,{faces,assumeValidated:true});expect(settled.master).toEqual(ordinary.master);expect(settled.master.geometry.nodes.b0).toBe(master.geometry.nodes.b0);
 });
 it('preserves smooth shared-handle behavior without mutating an adjoining input edge',()=>{
  let master=fixture();master=applyOperation(master,{t:'setNodeKind',nodeId:'a1',kind:'smooth'}).master;const before=structuredClone(master),faces=topology.buildPlanarMap(master.geometry,master.bounds,master.repeat).faces;
  const op:Operation={t:'setControls',edgeId:'a',segIndex:0,c2:{x:60,y:10}};
  const deferred=applyOperation(master,op,{faces,assumeValidated:true,deferTopology:true}),ordinary=applyOperation(master,op,{faces});expect(deferred.master.geometry.edges).toEqual(ordinary.master.geometry.edges);expect(master).toEqual(before);
 });
 it('checks locks, finite fixed-point limits, IDs and chain validity before committing',()=>{
  const master=fixture();master.objects[0].locked=true;
  for(const op of operations)expect(()=>applyOperation(master,op,{assumeValidated:true,deferTopology:true})).toThrow(/locked/);
  master.objects[0].locked=false;
  for(const op of [{t:'moveNodes',nodes:[{id:'a1',to:{x:1e100,y:0}}]},{t:'insertNode',edgeId:'a',segIndex:0,tParam:0,nodeId:'bad'},{t:'deleteNode',edgeId:'a',nodeId:'missing'}] as Operation[])expect(()=>applyOperation(master,op,{assumeValidated:true,deferTopology:true})).toThrow();
  master.geometry.edges.a.nodeIds=['a0','a1','a0','a2'];master.geometry.edges.a.segments=[{},{},{}];expect(()=>applyOperation(master,{t:'deleteNode',edgeId:'a',nodeId:'a1'},{assumeValidated:true,deferTopology:true})).toThrow(/Invalid edge chain/);
 });
 it('keeps unsupported operation kinds on the full settlement path',()=>{
  const master=fixture(),result=applyOperation(master,{t:'transformObjects',objectIds:['a'],matrix:[1,0,0,1,4,0]},{assumeValidated:true,deferTopology:true});expect(result.faces).toBeDefined();expect(result.faces!.filter(face=>face.outer)).toHaveLength(2);
 });
 const add:Operation={t:'addEdge',objectId:'a',edge:{id:'added',nodeIds:['new0','new1'],segments:[{c1:{x:162.123,y:26.345}}],width:3,widthMode:'design',colorIndex:5,z:0},nodes:[{id:'new0',p:{x:155.678,y:20.123},kind:'corner'},{id:'new1',p:{x:178.456,y:70.789},kind:'corner'}]};
 it.each([add,{t:'deleteEdge',edgeId:'a'},{t:'deleteObjects',objectIds:['a']}] as Operation[])('defers $t with the same final ownership, fills and snapped geometry',operation=>{
  expect(DEFERRED_GEOMETRY_OPERATIONS).toContain(operation.t);
  const master=fixture(),before=structuredClone(master),faces=topology.buildPlanarMap(master.geometry,master.bounds,master.repeat).faces;
  const ordinary=applyOperation(master,operation,{faces}),spy=vi.spyOn(topology,'buildPlanarMap');let deferred;
  try{deferred=applyOperation(master,operation,{faces,assumeValidated:true,deferTopology:true});expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
  expect(deferred.faces).toBeUndefined();expect(deferred.geometryChanged).toBe(true);expect(deferred.master.geometry.faceColors).toBe(master.geometry.faceColors);expect(master).toEqual(before);
  expect(deferred.master.geometry.nodes.b0).toBe(master.geometry.nodes.b0);expect(deferred.master.geometry.edges.b).toBe(master.geometry.edges.b);
  const built=topology.buildPlanarMap(deferred.master.geometry,master.bounds,master.repeat),tracked=topology.trackFaces(faces,deferred.master.geometry.faceColors,built.faces);
  expect(validateMaster({...deferred.master,geometry:{...deferred.master.geometry,faceColors:tracked.faceColors}})).toEqual(ordinary.master);expect(tracked.faces).toEqual(ordinary.faces);
 });
 it('checks added-edge styles, nodes, chain and locked ownership before a deferred commit',()=>{
  const master=fixture(),before=structuredClone(master);
  if(add.t!=='addEdge')throw new Error('fixture');
  for(const edge of [{...add.edge,widthMode:'output' as const,width:9},{...add.edge,colorIndex:6},{...add.edge,colorIndex:undefined},{...add.edge,nodeIds:['new0','new0']},{...add.edge,segments:[]}])expect(()=>applyOperation(master,{...add,edge},{assumeValidated:true,deferTopology:true})).toThrow();
  expect(()=>applyOperation(master,{...add,nodes:[{...add.nodes[0],p:{x:1e100,y:0}},add.nodes[1]]},{assumeValidated:true,deferTopology:true})).toThrow();expect(master).toEqual(before);
  master.objects[0].locked=true;
  for(const operation of [add,{t:'deleteEdge',edgeId:'a'},{t:'deleteObjects',objectIds:['a']}] as Operation[])expect(()=>applyOperation(master,operation,{assumeValidated:true,deferTopology:true})).toThrow(/locked/);
 });
});
