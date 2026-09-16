import {describe,it,expect} from 'vitest';
import {EditorEngine} from './editor-engine';
import {applyEditorPatch} from './editor-patch';
import {settle} from './settle.worker';
import {toolAvailable} from './DesignCanvas';
import {DEFAULT_PALETTE,DEFAULT_PROFILE,type Master} from '../../../packages/core/src/types';
import type {DesignRecord,EditorAction} from '../../../packages/app-model/src/index';
import {encodeBmp} from '../../../packages/core/src/bmp';
import {applyOperation} from '../../../packages/core/src/ops';

const pixels=Uint8Array.from({length:64},(_,i)=>i===18?3:i%8<4?1:2);
function fixture(kind:'master'|'size'='size'):DesignRecord {
  const master:Master={schemaVersion:1,id:'image',workspaceId:'test',name:'Colored image',tags:[],createdAt:'created',updatedAt:'old',bounds:{w:8,h:8},repeat:{type:'none'},palette:structuredClone(DEFAULT_PALETTE),geometry:{nodes:{},edges:{},faceColors:{}},objects:[],raster:{width:8,height:8,pixelsBase64:Buffer.from(pixels).toString('base64')},source:{fileId:'image.png',widthPx:8,heightPx:8},traceParams:{threshold:'otsu',invert:false,minSpeckArea:0,gapClosePx:0,spurPrunePx:0,simplifyTolerance:1,fitMaxError:1.5,cornerAngleDeg:60},version:1};
  return {id:kind==='size'?'size':'image',kind,...(kind==='size'?{masterId:'image',baseMasterVersion:1}:{}),name:master.name,tags:[],master,revision:1,createdAt:'created',updatedAt:'old',profileId:DEFAULT_PROFILE.id,sizeInput:{mode:'grid',widthPx:8,heightPx:8,linkAspect:false},rules:{minRegionPx:0,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false},pixelOverrides:[],operations:[]};
}

describe('uploaded image editor',()=>{
  it('counts every source pixel even when a rare color is missed by the master preview, then updates after merge and undo',async()=>{
    const engine=new EditorEngine(),sourcePixels=new Uint8Array(64*32).fill(1);sourcePixels[0]=2;
    let document=fixture('master'),requestId=1;
    document.master.bounds={w:64,h:32};document.master.raster={width:64,height:32,pixelsBase64:Buffer.from(sourcePixels).toString('base64')};
    document.master.source={...document.master.source,widthPx:64,heightPx:32};
    const initial=engine.handle({type:'init',requestId,document,profile:DEFAULT_PROFILE,previewWidth:16});if(initial.type!=='ready')throw new Error('init');
    expect([initial.render.widthPx,initial.render.heightPx]).toEqual([16,8]);
    expect(initial.render.grid.includes(2)).toBe(false);
    expect(initial.render.sourceColorPixelCounts).toEqual([0,2047,1,0,0,0]);
    document=initial.document;
    async function send(request:{type:'action';action:EditorAction}|{type:'undo'}){
      const reply=engine.handleInteractive({...request,requestId:++requestId});if(reply.type!=='committed')throw new Error(reply.type==='error'?reply.message:'commit');
      document=await applyEditorPatch(document,structuredClone(reply.patch));
      const derived=settle(engine.settlementInput());engine.acceptDerived(derived.state,derived.cache);document=derived.state.document;return derived.state;
    }
    const merged=await send({type:'action',action:{type:'operation',operation:{t:'mergePalette',sourceIndex:2,targetIndex:1}}});
    expect(merged.render.sourceColorPixelCounts).toEqual([0,2048,0,0,0]);
    const restored=await send({type:'undo'});
    expect(restored.render.sourceColorPixelCounts).toEqual(initial.render.sourceColorPixelCounts);
    expect(restored.document.master.raster).toEqual(initial.document.master.raster);
    const rerender=engine.handle({type:'render',requestId:++requestId,previewWidth:32});if(rerender.type!=='state')throw new Error('render');
    expect(rerender.render.sourceColorPixelCounts).toEqual([0,2047,1,0,0,0]);
  });

  it('does not label size counts as source counts',()=>{
    const engine=new EditorEngine(),reply=engine.handle({type:'init',requestId:1,document:fixture(),profile:DEFAULT_PROFILE});
    if(reply.type!=='ready')throw new Error('init');
    expect(reply.render.sourceColorPixelCounts).toBeUndefined();
  });

  it('accepts remapped rebase colors together with the updated master and restores them through undo',()=>{
    const engine=new EditorEngine(),document=fixture();
    document.rules={...document.rules,outlineAlgorithm:'conservative',repairColorIndices:[3],outlineColorIndex:3,cleanupColorIndices:[3],protectedColorIndices:[3]};document.pixelOverrides=[{x:0,y:0,colorIndex:3}];
    const initial=engine.handle({type:'init',requestId:1,document,profile:DEFAULT_PROFILE});if(initial.type!=='ready')throw new Error('init');
    const master=applyOperation(initial.document.master,{t:'mergePalette',sourceIndex:1,targetIndex:0}).master;
    const rules={...document.rules,repairColorIndices:[2],outlineColorIndex:2,cleanupColorIndices:[2],protectedColorIndices:[2]},pixelOverrides=[{x:0,y:0,colorIndex:2}];
    const updated=engine.handle({type:'action',requestId:2,action:{type:'replace',master,rules,pixelOverrides,operations:[],baseMasterVersion:2}});
    if(updated.type!=='state')throw new Error(updated.type==='error'?updated.message:'state');
    expect(updated.document.rules).toEqual(rules);expect(updated.render.grid[0]).toBe(2);
    const undo=engine.handle({type:'undo',requestId:3});if(undo.type!=='state')throw new Error('undo');
    expect(undo.document.rules).toEqual(document.rules);expect(undo.document.pixelOverrides).toEqual(document.pixelOverrides);expect(undo.document.master.raster).toEqual(document.master.raster);
  });

  it('renders a master in the source pixel proportion with its filled colors',()=>{
    const engine=new EditorEngine(),reply=engine.handle({type:'init',requestId:1,document:fixture('master'),profile:DEFAULT_PROFILE,previewWidth:1200});
    expect(reply.type).toBe('ready');if(reply.type!=='ready')throw new Error('init');
    expect([reply.render.widthPx,reply.render.heightPx]).toEqual([8,8]);expect(reply.render.grid).toEqual(pixels);
    expect(reply.render.report.unassignedFaces).toBe(0);expect(reply.stats.edges).toBe(0);
    expect(toolAvailable('fill',reply.document)).toBe(false);expect(toolAvailable('pen',reply.document)).toBe(false);expect(toolAvailable('pixel',reply.document)).toBe(false);expect(toolAvailable('zoom',reply.document)).toBe(true);
  });

  it('resizes, applies cleanup and pixel corrections, and restores edits through undo',()=>{
    const engine=new EditorEngine();let requestId=1;
    engine.handle({type:'init',requestId,document:fixture(),profile:DEFAULT_PROFILE});
    const action=(action:EditorAction)=>{const reply=engine.handle({type:'action',requestId:++requestId,action});if(reply.type!=='state')throw new Error(reply.type==='error'?reply.message:'state');return reply;};
    const clean=action({type:'rules',rules:{...fixture().rules,minRegionPx:2}});expect(clean.render.grid[18]).toBe(1);expect(clean.render.changedPixelsMask[18]).not.toBe(0);
    const corrected=action({type:'pixels',pixels:[{x:2,y:2,colorIndex:4}]});expect(corrected.render.grid[18]).toBe(4);
    const resized=action({type:'size',profileId:DEFAULT_PROFILE.id,sizeInput:{mode:'grid',widthPx:16,heightPx:16,linkAspect:false}});
    expect([resized.render.widthPx,resized.render.heightPx]).toEqual([16,16]);expect(resized.render.grid[34]).toBe(4);expect(resized.document.master.raster).toEqual(fixture().master.raster);
    const undo=engine.handle({type:'undo',requestId:++requestId});expect(undo.type).toBe('state');if(undo.type!=='state')throw new Error('undo');
    expect(undo.document.sizeInput).toEqual(fixture().sizeInput);expect(undo.render.grid).toEqual(corrected.render.grid);
    const exported=engine.handle({type:'export',requestId:++requestId,format:'bmp'});expect(exported.type).toBe('export');if(exported.type!=='export')throw new Error('export');
    expect(exported.bytes).toEqual(encodeBmp(corrected.render.grid,8,8,corrected.document.master.palette,DEFAULT_PROFILE));
  });

  it.each([4,7,256])('keeps a %i-color palette, raster, protected colors and overrides synchronized through merge and undo',async(colorCount)=>{
    const engine=new EditorEngine();let requestId=1,document=fixture();const sourceIndex=colorCount-1;
    document.master.palette={entries:Array.from({length:colorCount},(_,index)=>({index,name:'Color '+index,displayRgb:[index,255-index,50],exportRgb:[index,255-index,50]}))};
    document.master.raster!.pixelsBase64=Buffer.from(Uint8Array.from(pixels,(pixel,index)=>index===18?sourceIndex:pixel)).toString('base64');
    document.rules.protectedColorIndices=[sourceIndex];
    document.rules.cleanupColorIndices=[sourceIndex,2];document.rules.outlineColorIndex=sourceIndex;document.rules.cleanupRegion={x:0,y:0,w:.5,h:1};
    document.rules.outlineAlgorithm='conservative';document.rules.repairColorIndices=[sourceIndex,1,2];
    const initial=engine.handle({type:'init',requestId,document,profile:DEFAULT_PROFILE});if(initial.type!=='ready')throw new Error('init');document=initial.document;
    const painted=engine.handle({type:'action',requestId:++requestId,action:{type:'pixels',pixels:[{x:0,y:0,colorIndex:sourceIndex}]}});if(painted.type!=='state')throw new Error(painted.type==='error'?painted.message:'paint');document=painted.document;expect(painted.render.grid[0]).toBe(sourceIndex);
    const original=structuredClone(document);
    async function send(request:{type:'action';action:EditorAction}|{type:'undo'|'redo'}){
      const reply=engine.handleInteractive({...request,requestId:++requestId});if(reply.type!=='committed')throw new Error(reply.type==='error'?reply.message:'commit');
      document=await applyEditorPatch(document,structuredClone(reply.patch));expect(document).toEqual(engine.settlementInput().document);
      const derived=settle(engine.settlementInput());engine.acceptDerived(derived.state,derived.cache);document=derived.state.document;return derived.state;
    }
    const merged=await send({type:'action',action:{type:'operation',operation:{t:'mergePalette',sourceIndex,targetIndex:1}}});
    expect(document.master.palette.entries).toEqual(original.master.palette.entries.slice(0,-1));expect(document.master.palette.entries.length).toBe(colorCount-1);
    expect(Buffer.from(document.master.raster!.pixelsBase64,'base64')[18]).toBe(1);expect(document.rules.protectedColorIndices).toEqual([1]);expect(document.pixelOverrides[0].colorIndex).toBe(1);expect(merged.render.grid[18]).toBe(1);
    expect(document.rules.cleanupColorIndices).toEqual([1,2]);expect(document.rules.outlineColorIndex).toBe(1);expect(document.rules.cleanupRegion).toEqual(original.rules.cleanupRegion);
    expect(document.rules.repairColorIndices).toEqual([1,2]);
    const restored=await send({type:'undo'});expect(document.master.raster).toEqual(original.master.raster);expect(document.master.palette).toEqual(original.master.palette);expect(restored.render.grid[18]).toBe(sourceIndex);expect(document.pixelOverrides).toEqual(original.pixelOverrides);
    expect(document.rules).toEqual(original.rules);
    await send({type:'redo'});expect(document.master.raster).toEqual(merged.document.master.raster);expect(document.rules.repairColorIndices).toEqual([1,2]);
    expect(toolAvailable('pixel',document)).toBe(true);expect(toolAvailable('node',document)).toBe(false);
  });
});
