import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, type Master } from './types';
import { remapMasterPalette, validateMaster } from './schemas';
import { encodeBmp } from './bmp';
import { encodePng } from './png';
import { applyRules } from './rules';

function fixture():Master {
  return {schemaVersion:1,id:'palette',workspaceId:'test',name:'Palette test',tags:[],createdAt:'2026-09-12',updatedAt:'2026-09-12',
    bounds:{w:100,h:100},repeat:{type:'none'},palette:structuredClone(DEFAULT_PALETTE),
    geometry:{nodes:{a:{id:'a',p:{x:10,y:20},kind:'corner'},b:{id:'b',p:{x:80,y:20},kind:'corner'}},
      edges:{e:{id:'e',nodeIds:['a','b'],segments:[{}],width:12,widthMode:'design',colorIndex:5,z:0}},
      faceColors:{ground:{colorIndex:0,ref:{x:1,y:1}}}},
    objects:[{id:'o',name:'Stroke',edgeIds:['e'],hidden:false,locked:false}],
    source:{fileId:'test',widthPx:100,heightPx:100},traceParams:{threshold:128,invert:false,minSpeckArea:0,gapClosePx:0,spurPrunePx:0,simplifyTolerance:1,fitMaxError:1,cornerAngleDeg:60},version:1};
}

describe('six-color masters and stroke persistence',()=>{
  it('counts ground and strokes within six entries across document and pixel export',()=>{
    const master=fixture(); expect(validateMaster(master).palette.entries).toHaveLength(6);
    const grid=new Uint8Array([0,5]);
    expect(encodeBmp(grid,2,1,master.palette,{epi:60,ppi:48}).length).toBeGreaterThan(1000);
    master.palette.entries.push({...master.palette.entries[5],index:6});
    expect(()=>validateMaster(master)).toThrow('six');
    expect(()=>encodeBmp(grid,2,1,master.palette,{epi:60,ppi:48})).toThrow('palette');
    expect(()=>encodePng(grid,2,1,master.palette)).toThrow('palette');
    expect(()=>applyRules(grid,2,1,master.palette)).toThrow('1–6');
  });
  it('round-trips design widths and hidden state while retaining legacy pixel-width limits',()=>{
    const master=fixture();master.geometry.edges.e.strokeHidden=true;
    expect(validateMaster(JSON.parse(JSON.stringify(master)))).toEqual(master);
    delete master.geometry.edges.e.widthMode;
    expect(()=>validateMaster(master)).toThrow('exceeds 8');
    master.geometry.edges.e.width=2;
    expect(validateMaster(master).geometry.edges.e.widthMode).toBeUndefined();
    master.geometry.edges.e.colorIndex=6;
    expect(()=>validateMaster(master)).toThrow('outside the palette');
  });
  it('requires an explicit complete mapping for old palettes and preserves original data',()=>{
    const legacy=fixture();
    legacy.palette.entries.push({...legacy.palette.entries[2],index:6},{...legacy.palette.entries[5],index:7});
    legacy.geometry.edges.e.colorIndex=7;legacy.geometry.edges.e.strokeHidden=true;
    legacy.geometry.faceColors.ground.colorIndex=6;
    const before=JSON.stringify(legacy);
    const result=remapMasterPalette(legacy,DEFAULT_PALETTE,[0,1,2,3,4,2,3,5]);
    expect(result.geometry.edges.e).toMatchObject({colorIndex:5,width:12,widthMode:'design',strokeHidden:true});
    expect(result.geometry.faceColors.ground.colorIndex).toBe(3);
    expect(result.palette.entries).toHaveLength(6);
    expect(JSON.stringify(legacy)).toBe(before);
    expect(()=>remapMasterPalette(legacy,DEFAULT_PALETTE,[0,1])).toThrow('every old');
    expect(()=>remapMasterPalette(legacy,DEFAULT_PALETTE,[0,1,2,3,4,2,3,6])).toThrow('every old');
  });
});
