import {describe,it,expect} from 'vitest';
import {cleanupPreviewIsCurrent,compareCleanupPixels,gentleCleanupRules,lineRepairRules} from './cleanup-preview';

describe('reviewable cleanup proposal',()=>{
  it('keeps scope, protected colors and outline selection while proposing gentle removal',()=>{
    const current={minRegionPx:8,minThicknessPx:3,removeCheckerboard:true,connectVisibleEdges4:true,rasterResize:'preserve-outline' as const,repairOutlineGaps:true,outlineColorIndex:255,protectedColorIndices:[7],cleanupColorIndices:[0],cleanupRegion:{x:.2,y:.3,w:.4,h:.5}};
    const proposed=gentleCleanupRules(current);
    expect(proposed).toEqual({...current,minRegionPx:2,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false,rasterResize:'nearest',repairOutlineGaps:false,outlineAlgorithm:'conservative'});
    expect(current.removeCheckerboard).toBe(true);
  });
  it('reports actual differences, including restored pixels and both colors of an edit',()=>{
    const before=Uint8Array.from([0,255,2,2,0,0]),after=Uint8Array.from([255,0,2,1,0,0]);
    const result=compareCleanupPixels(before,after,256,3);
    expect(result.changedPixels).toBe(3);expect(result.colorDeltas[0]).toBe(0);expect(result.colorDeltas[255]).toBe(0);expect(result.colorDeltas[2]).toBe(-1);expect(result.colorDeltas[1]).toBe(1);
    expect(result.locations).toEqual([0]);expect(compareCleanupPixels(before,before,256,3).changedPixels).toBe(0);
  });
  it('rejects incompatible grids and prevents adoption after edits or pending rendering',()=>{
    expect(()=>compareCleanupPixels(new Uint8Array(2),new Uint8Array(3),2,2)).toThrow(/same pixel grid/);
    expect(cleanupPreviewIsCurrent(4,4,false)).toBe(true);expect(cleanupPreviewIsCurrent(4,5,false)).toBe(false);expect(cleanupPreviewIsCurrent(4,4,true)).toBe(false);
  });
  it('treats the region limit as inclusive and keeps larger removal an explicit bounded proposal',()=>{
    const current={minRegionPx:2,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false,cleanupColorIndices:[3],cleanupRegion:{x:.7,y:.1,w:.1,h:.1}};
    expect(gentleCleanupRules(current,12)).toMatchObject({minRegionPx:13,cleanupColorIndices:[3],cleanupRegion:current.cleanupRegion});
    for(const invalid of [0,65,1.5,NaN])expect(()=>gentleCleanupRules(current,invalid)).toThrow(/1 to 64/);
    expect(current.minRegionPx).toBe(2);
  });
  it('previews selected line colors without resetting existing speck processing or sampling',()=>{
    const current={minRegionPx:2,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false,rasterResize:'preserve-outline' as const,outlineColorIndex:4,protectedColorIndices:[2],cleanupColorIndices:[0,2],cleanupRegion:{x:.1,y:.2,w:.4,h:.3}};
    const colors=[255,0];
    expect(lineRepairRules(current,colors,256)).toEqual({...current,outlineAlgorithm:'conservative',repairOutlineGaps:true,repairColorIndices:[0,255]});
    expect(colors).toEqual([255,0]);
    for(const selection of [[],[0,0],[256],[-1],[.5],Array.from({length:9},(_,i)=>i)])expect(()=>lineRepairRules(current,selection,256)).toThrow(/1 to 8/);
  });
  it('includes changed areas beyond the first hundred tiles',()=>{
    const before=new Uint8Array(64*120),after=before.slice();
    for(let i=0;i<120;i++)after[i*64]=1;
    const difference=compareCleanupPixels(before,after,2,before.length);
    expect(difference.locations).toHaveLength(120);expect(difference.locations.at(-1)).toBe(119*64);
  });
});
