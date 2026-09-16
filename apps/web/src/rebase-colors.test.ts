import {describe,it,expect} from 'vitest';
import type {DesignRecord} from '../../../packages/app-model/src/index';
import type {Master,Palette} from '../../../packages/core/src/types';
import {rebaseColorReferences} from './rebase-colors';

const palette:Palette={entries:[
  {index:0,name:'Ground',displayRgb:[255,255,255],exportRgb:[255,255,255]},
  {index:1,name:'Red',displayRgb:[255,0,0],exportRgb:[254,0,0]},
  {index:2,name:'Blue',displayRgb:[0,0,255],exportRgb:[0,0,254]},
  {index:3,name:'Green',displayRgb:[0,255,0],exportRgb:[0,254,0]},
]};
const master=(entries:Palette['entries']):Master=>({palette:{entries:entries.map((entry,index)=>({...structuredClone(entry),index}))}} as Master);
function variant():DesignRecord{return {
  master:master(palette.entries),
  rules:{minRegionPx:4,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false,rasterResize:'preserve-outline',outlineColorIndex:2,protectedColorIndices:[0,2],cleanupColorIndices:[2,3],cleanupRegion:{x:0,y:0,w:.5,h:1}},
  pixelOverrides:[{x:5,y:7,colorIndex:2},{x:2,y:2,colorIndex:0}],
} as DesignRecord;}

describe('rebase palette references',()=>{
  it('remaps an in-range blue index after an earlier parent color is merged',()=>{
    const original=variant(),snapshot=structuredClone(original),updated=master([palette.entries[0],palette.entries[2],palette.entries[3]]);
    const result=rebaseColorReferences(original,updated);
    expect(result.rules).toEqual({...original.rules,outlineColorIndex:1,protectedColorIndices:[0,1],cleanupColorIndices:[1,2]});
    expect(result.pixelOverrides).toEqual([{x:5,y:7,colorIndex:1},{x:2,y:2,colorIndex:0}]);
    expect(original).toEqual(snapshot);
  });

  it('retains references and an explicit empty selection for an unchanged palette',()=>{
    const original=variant();original.rules.cleanupColorIndices=[];
    expect(rebaseColorReferences(original,master(palette.entries))).toEqual({rules:original.rules,pixelOverrides:original.pixelOverrides});
  });

  it('retains unchanged duplicate palette entries without guessing a new index',()=>{
    const original=variant();original.master=master([...palette.entries,{...palette.entries[2],index:4}]);
    expect(rebaseColorReferences(original,structuredClone(original.master)).rules.outlineColorIndex).toBe(2);
  });

  it('blocks a referenced color removed by a parent merge even if its index remains valid',()=>{
    const updated=master([palette.entries[0],palette.entries[1],palette.entries[3]]);
    expect(()=>rebaseColorReferences(variant(),updated)).toThrow(/Blue.*missing or has been recolored/);
  });

  it('blocks ambiguous identities after the palette changes',()=>{
    const updated=master([palette.entries[0],palette.entries[2],palette.entries[2],palette.entries[3]]);
    expect(()=>rebaseColorReferences(variant(),updated)).toThrow(/multiple identical matches/);
  });

  it.each(['name','displayRgb','exportRgb'] as const)('requires the same %s when preserving color identity',field=>{
    const updated=master(palette.entries);
    if(field==='name')updated.palette.entries[2].name='Renamed blue';else updated.palette.entries[2][field]=[20,20,220];
    expect(()=>rebaseColorReferences(variant(),updated)).toThrow(/Keep this size on its existing master, or create a new size/);
  });

  it('keeps ground at index zero and blocks a recolored ground even if its old color moved',()=>{
    const updated=master([palette.entries[1],palette.entries[0],palette.entries[2],palette.entries[3]]);
    expect(()=>rebaseColorReferences(variant(),updated)).toThrow(/ground color has changed/);
  });

  it('does not convert a referenced motif color into the reserved ground slot',()=>{
    const original=variant();original.rules.protectedColorIndices=[];original.pixelOverrides=[];
    const updated=master([palette.entries[2],palette.entries[1],palette.entries[3]]);
    expect(()=>rebaseColorReferences(original,updated)).toThrow(/reserved ground slot/);
  });

  it('allows unrelated palette changes when there are no indexed references',()=>{
    const original=variant();delete original.rules.outlineColorIndex;delete original.rules.rasterResize;delete original.rules.protectedColorIndices;delete original.rules.cleanupColorIndices;original.pixelOverrides=[];
    expect(rebaseColorReferences(original,master([palette.entries[0]]))).toEqual({rules:original.rules,pixelOverrides:[]});
  });

  it('remaps independent repair colors after a lower parent palette entry is removed',()=>{
    const original=variant();
    original.rules={minRegionPx:0,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false,outlineAlgorithm:'conservative',repairOutlineGaps:true,repairColorIndices:[3,2]};
    original.pixelOverrides=[];
    const before=structuredClone(original),updated=master([palette.entries[0],palette.entries[2],palette.entries[3]]);
    expect(rebaseColorReferences(original,updated)).toEqual({rules:{...original.rules,repairColorIndices:[1,2]},pixelOverrides:[]});
    expect(original).toEqual(before);
  });

  it('blocks a missing repair-only reference even while gap repair is off',()=>{
    const original=variant();
    original.rules={minRegionPx:0,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false,outlineAlgorithm:'conservative',repairOutlineGaps:false,repairColorIndices:[2]};
    original.pixelOverrides=[];
    const updated=master([palette.entries[0],palette.entries[1],palette.entries[3]]);
    expect(()=>rebaseColorReferences(original,updated)).toThrow(/Blue.*missing or has been recolored/);
  });
});
