import { describe,expect,it } from 'vitest';
import { applyOperation,commit,createHistory,redo,undo,setStrokeVisibility } from './ops';
import { buildPlanarMap,faceAt } from './topology';
import { materializeGeometry } from './materialize';
import { render } from './render';
import { DEFAULT_PALETTE,type Master,type RuleConfig } from './types';
import { validateMaster } from './schemas';

function fixture(divided=false):Master {
  const points=[[16,16],[80,16],[80,80],[16,80],[16,16]],geometry:Master['geometry']={nodes:{},edges:{},faceColors:{}};
  const add=(id:string,points:number[][])=>{const nodes=points.map(([x,y],i)=>{const n=`${id}-${i}`;geometry.nodes[n]={id:n,p:{x,y},kind:'corner'};return n;});geometry.edges[id]={id,nodeIds:nodes,segments:points.slice(1).map(()=>({})),width:0,z:0};};
  add('outer',points);if(divided)add('divider',[[48,16],[48,80]]);
  const faces=buildPlanarMap(geometry,{w:128,h:128}).faces;
  for(const face of faces)geometry.faceColors[face.id]={colorIndex:face.outer===null?0:face.ref.x<48?2:3,ref:face.ref};
  return validateMaster({schemaVersion:1,id:'test',workspaceId:'test',name:'Test',tags:[],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',bounds:{w:128,h:128},repeat:{type:'straight'},palette:DEFAULT_PALETTE,geometry,objects:Object.keys(geometry.edges).map(id=>({id,name:id,edgeIds:[id],hidden:false,locked:false})),source:{fileId:'test',widthPx:128,heightPx:128},traceParams:{threshold:'otsu',invert:false,minSpeckArea:0,gapClosePx:0,spurPrunePx:0,simplifyTolerance:1,fitMaxError:1.5,cornerAngleDeg:60},version:1});
}
const off:RuleConfig={minRegionPx:0,minThicknessPx:0,connectVisibleEdges4:false,removeCheckerboard:false};
function pixels(master:Master){const result=materializeGeometry(master);return render(result.geometry,result.faces,master.bounds,master.palette,128,128,off).grid;}

describe('persistent edits and exact history',()=>{
  it('hides only stroke ink, retaining widths, divided faces and exact undo state',()=>{
    const master=fixture(true);
    Object.assign(master.geometry.edges.divider,{width:5,widthMode:'design',colorIndex:5});
    const before=JSON.stringify(validateMaster(master)),faces=structuredClone(master.geometry.faceColors);
    const history=commit(createHistory(master),{t:'setStrokeVisibility',edgeIds:['divider'],hidden:true});
    expect(history.current.geometry.edges.divider).toMatchObject({width:5,widthMode:'design',colorIndex:5,strokeHidden:true});
    expect(history.current.geometry.nodes).toEqual(master.geometry.nodes);
    expect(history.current.geometry.faceColors).toEqual(faces);
    expect(pixels(master)[30*128+48]).toBe(5);
    expect(pixels(history.current)[30*128+47]).toBe(2);
    expect(pixels(history.current)[30*128+48]).toBe(3);
    expect(JSON.stringify(undo(history).current)).toBe(before);
    expect(redo(undo(history)).current).toEqual(history.current);
    const restored=applyOperation(history.current,{t:'setStrokeVisibility',edgeIds:['divider'],hidden:false}).master;
    expect(pixels(restored)).toEqual(pixels(master));
    expect(validateMaster(JSON.parse(JSON.stringify(history.current))).geometry.edges.divider.strokeHidden).toBe(true);
  });
  it('checks a whole visibility selection before changing anything and shares unchanged geometry',()=>{
    const master=fixture(true),before=JSON.stringify(master);
    master.objects.find(o=>o.id==='divider')!.locked=true;
    expect(()=>setStrokeVisibility(master,['outer','divider'],true)).toThrow('locked');
    master.objects.find(o=>o.id==='divider')!.locked=false;
    expect(()=>setStrokeVisibility(master,['outer','missing'],true)).toThrow('Missing');
    const hidden=setStrokeVisibility(master,['outer'],true);
    expect(hidden.geometry.nodes).toBe(master.geometry.nodes);
    expect(hidden.geometry.faceColors).toBe(master.geometry.faceColors);
    expect(hidden.geometry.edges.divider).toBe(master.geometry.edges.divider);
    expect(JSON.stringify(master)).toBe(before);
  });
  it('retains moved face colors after save/reload and a second edit',()=>{
    const master=fixture(),color=master.geometry.faceColors[faceAt(buildPlanarMap(master.geometry,master.bounds).faces,{x:30,y:30})!.id].colorIndex;
    const moved=applyOperation(master,{t:'transformObjects',objectIds:['outer'],matrix:[1,0,0,1,30,20]}).master;
    const reloaded=validateMaster(JSON.parse(JSON.stringify(moved)));
    expect(pixels(reloaded)[50*128+60]).toBe(color);
    const movedAgain=applyOperation(reloaded,{t:'transformObjects',objectIds:['outer'],matrix:[1,0,0,1,5,5]}).master;
    expect(pixels(movedAgain)[55*128+65]).toBe(color);
    expect(master.geometry.nodes['outer-0'].p).toEqual({x:16,y:16});
  });
  it('restores byte-identical document data after a snapped affine transformation',()=>{
    const master=fixture(),initial=JSON.stringify(master);
    const history=commit(createHistory(master),{t:'transformObjects',objectIds:['outer'],matrix:[1.03,0.14,-0.14,1.03,0.01,0.03]});
    expect(JSON.stringify(undo(history).current)).toBe(initial);
    expect(redo(undo(history)).current).toEqual(history.current);
    expect(commit(undo(history),{t:'setObjectFlags',objectId:'outer',locked:true,hidden:false}).future).toEqual([]);
  });
  it('keeps a visible merged region colored when an internal divider is hidden',()=>{
    const master=fixture(true);master.objects.find(o=>o.id==='divider')!.hidden=true;
    const result=materializeGeometry(master),face=faceAt(result.faces,{x:30,y:30})!;
    expect(result.geometry.faceColors[face.id].colorIndex).not.toBeNull();
    expect([2,3]).toContain(pixels(master)[30*128+30]);
    expect(pixels(master)[30*128+30]).toBe(pixels(master)[30*128+60]);
    expect(result.warnings.some(w=>/Merged colors/.test(w))).toBe(true);
  });
  it('preserves ground recoloring through serialization and rejects missing palette indices',()=>{
    const master=fixture();const ground=buildPlanarMap(master.geometry,master.bounds).faces.find(f=>f.id==='ground')!;
    const edited=applyOperation(master,{t:'setFaceColor',faceId:'ground',ref:ground.ref,colorIndex:4}).master;
    expect(pixels(JSON.parse(JSON.stringify(edited)))[0]).toBe(4);
    expect(()=>applyOperation(master,{t:'setFaceColor',faceId:'ground',ref:ground.ref,colorIndex:12})).toThrow();
  });
  it('does not move locked geometry and moves curve handles with anchors',()=>{
    const master=fixture();master.objects[0].locked=true;
    expect(()=>applyOperation(master,{t:'moveNodes',nodes:[{id:'outer-0',to:{x:20,y:20}}]})).toThrow('locked');
    master.objects[0].locked=false;master.geometry.edges.outer.segments[0].c1={x:24,y:16};
    const edited=applyOperation(master,{t:'moveNodes',nodes:[{id:'outer-0',to:{x:18,y:19}}]}).master;
    expect(edited.geometry.edges.outer.segments[0].c1).toEqual({x:26,y:19});
  });
});
