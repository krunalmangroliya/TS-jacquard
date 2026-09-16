import {describe,expect,it,vi} from 'vitest';
import {ConservativeRasterOutline} from './raster-outline-v2';
import {encodeRaster} from './raster';
import {render} from './render';
import {ruleSchema} from './schemas';
import {validateRuleConfig} from './rules';
import {DEFAULT_RASTER_RULES,type Palette,type RuleConfig} from './types';
const palette:Palette={entries:Array.from({length:256},(_,index)=>({index,name:`Ink${index}`,displayRgb:[index,index,index],exportRgb:[index,index,index]}))};
const empty={nodes:{},edges:{},faceColors:{}};
const rules:RuleConfig={...DEFAULT_RASTER_RULES,outlineAlgorithm:'conservative',repairOutlineGaps:true,repairColorIndices:[255,7]};
function strokes(secondY=5){
 const w=21,h=27,source=new Uint8Array(w*h);
 for(const [x,y,color]of [[3,1,255],[3,secondY,7]]){
  const left=(x-1)*3,top=(y-1)*3;
  for(let k=0;k<9;k++)source[(top+(k>=3&&k<=5?3:4))*w+left+k]=color;
  source[(top+3)*w+left+2]=color;source[(top+3)*w+left+6]=color;
 }
 return source;
}
function output(source:Uint8Array,cfg:RuleConfig=rules,overrides:{x:number;y:number;colorIndex:number}[]=[]){return render(empty,[],{w:21,h:27},palette,7,9,cfg,overrides,{type:'none'},encodeRaster(21,27,source));}

describe('selected line-color repair',()=>{
 it('repairs two separate inks from the same source without a preservation color',()=>{
  const source=strokes(),before=output(source,DEFAULT_RASTER_RULES),after=output(source);
  expect(before.grid[1*7+3]).toBe(0);expect(before.grid[5*7+3]).toBe(0);
  expect(after.grid[1*7+3]).toBe(255);expect(after.grid[5*7+3]).toBe(7);
  expect(after.report.changedPixelsByRule.repairOutlineGaps).toBe(2);
  expect([...after.grid].filter((c,p)=>c!==before.grid[p])).toHaveLength(2);
 });
 it('rejects separately valid different-ink proposals whose detail checks overlap',()=>{
  const source=strokes(3),before=output(source,DEFAULT_RASTER_RULES);
  expect(output(source,{...rules,repairColorIndices:[255]}).report.changedPixelsByRule.repairOutlineGaps).toBe(1);
  expect(output(source,{...rules,repairColorIndices:[7]}).report.changedPixelsByRule.repairOutlineGaps).toBe(1);
  const after=output(source);expect(after.grid).toEqual(before.grid);
  expect(after.report.warnings).toContain('Left 2 overlapping or nearby line-color proposals unchanged; review these junctions manually.');
 });
 it('rejects a shared-cell tie and its nearby proposals regardless of color order',()=>{
  const input=new Uint8Array(49),scope=new Uint8Array(49).fill(1),immutable=new Uint8Array(49);
  const spy=vi.spyOn(ConservativeRasterOutline.prototype,'plan').mockImplementation((_input,_scope,_immutable,cfg)=>{
   const grid=input.slice(),changed=new Uint8Array(49);grid[24]=cfg.outlineColorIndex!;changed[24]=1;
   const p=cfg.outlineColorIndex===255?22:26;grid[p]=cfg.outlineColorIndex!;changed[p]=1;
   return{repaired:{grid,changed,count:2,skipped:0}};
  });
  try{
   for(const colors of [[255,7],[7,255]]){
    const result=new ConservativeRasterOutline(new Uint8Array(441),21,21,7,7,255).planColors(input,scope,immutable,{...rules,repairColorIndices:colors});
    expect(result.repaired?.grid).toEqual(input);expect(result.repaired?.count).toBe(0);expect(result.conflictingPixels).toBe(3);
   }
  }finally{spy.mockRestore();}
 });
 it('preserves selection order and palette permutation invariance, including ink 255',()=>{
  const source=strokes(),result=output(source);
  expect(output(source,{...rules,repairColorIndices:[7,255]}).grid).toEqual(result.grid);
  const mapping=Array.from({length:256},(_,i)=>255-i);
  const permuted=output(source.map(c=>mapping[c]),{...rules,repairColorIndices:[mapping[7],mapping[255]]});
  expect([...permuted.grid]).toEqual([...result.grid].map(c=>mapping[c]));
 });
 it('honors original-color scope, protected color, selected area and manual corrections',()=>{
  const source=strokes(),before=output(source,DEFAULT_RASTER_RULES);
  for(const extra of [{cleanupColorIndices:[]},{cleanupColorIndices:[7,255]},{protectedColorIndices:[0]}])expect(output(source,{...rules,...extra}).grid).toEqual(before.grid);
  const scoped=output(source,{...rules,cleanupRegion:{x:0,y:0,w:1,h:1/3}});
  expect(scoped.grid[10]).toBe(255);expect(scoped.grid[38]).toBe(0);
  const manual=output(source,rules,[{x:3,y:1,colorIndex:9}]);
  expect(manual.grid[10]).toBe(9);expect(manual.report.changedPixelsMask[10]).toBe(0);expect(manual.grid[38]).toBe(7);
 });
 it('does not use accepted proposals to create later repairs or change an unselected ink',()=>{
  const source=strokes(),a=output(source,{...rules,repairColorIndices:[255]}),b=output(source,{...rules,repairColorIndices:[7]}),both=output(source),before=output(source,DEFAULT_RASTER_RULES);
  for(let p=0;p<before.grid.length;p++)if(both.grid[p]!==before.grid[p])expect(a.grid[p]===both.grid[p]||b.grid[p]===both.grid[p]).toBe(true);
  expect(a.grid[38]).toBe(0);
 });
 it('retains the existing conservative one-ink output when the list contains that ink',()=>{
  const source=strokes();
  const single=output(source,{...DEFAULT_RASTER_RULES,outlineAlgorithm:'conservative',outlineColorIndex:255,repairOutlineGaps:true});
  const selected=output(source,{...rules,repairColorIndices:[255]});
  expect(selected.grid).toEqual(single.grid);expect(selected.report.changedPixelsByRule).toEqual(single.report.changedPixelsByRule);
 });
 it('keeps preservation ink separate and never silently repairs its gaps',()=>{
  const source=strokes();for(let y=0;y<27;y++)source[y*21]=255;
  const result=output(source,{...rules,rasterResize:'preserve-outline',outlineColorIndex:255,repairColorIndices:[7]});
  expect(result.report.changedPixelsByRule.preserveOutline).toBeGreaterThan(0);
  expect(result.report.changedPixelsByRule.repairOutlineGaps).toBe(1);
  expect(result.grid[10]).toBe(0);expect(result.grid[38]).toBe(7);
 });
 it('validates the saved bounded selection and keeps preservation ink separate',()=>{
  expect(ruleSchema.parse(rules)).toEqual(rules);expect(()=>validateRuleConfig(rules,palette)).not.toThrow();
  for(const colors of [[],[7,7],Array.from({length:9},(_,i)=>i),[-1],[256],[1.5]]){
   expect(()=>ruleSchema.parse({...rules,repairColorIndices:colors})).toThrow();
   expect(()=>validateRuleConfig({...rules,repairColorIndices:colors},palette)).toThrow();
  }
  for(const outlineAlgorithm of [undefined,'legacy']as const){
   expect(()=>ruleSchema.parse({...rules,outlineAlgorithm,repairOutlineGaps:false})).toThrow();
   expect(()=>validateRuleConfig({...rules,outlineAlgorithm,repairOutlineGaps:false},palette)).toThrow();
  }
  expect(()=>validateRuleConfig({...rules,rasterResize:'preserve-outline'},palette)).toThrow(/outline color/);
  expect(()=>ruleSchema.parse({...rules,rasterResize:'preserve-outline'})).toThrow();
  expect(()=>validateRuleConfig({...rules,repairColorIndices:[7]},{entries:palette.entries.slice(0,7)})).toThrow();
 });
});
