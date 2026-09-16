import {describe,expect,it} from 'vitest';
import {encodeRaster} from '../../../packages/core/src/raster';
import {CleanupSourcePreviewCache,cleanupDetailCrop,createSourceDetailPreview,mapCleanupSourceCrop,SOURCE_DETAIL_MAX_SIDE} from './cleanup-source-preview';

describe('source detail coordinates',()=>{
  it('shares a clamped 128-pixel output crop at every edge, including small outputs',()=>{
    expect(cleanupDetailCrop(400,300,0)).toEqual({x:0,y:0,w:128,h:128});
    expect(cleanupDetailCrop(400,300,150*400+200)).toEqual({x:136,y:86,w:128,h:128});
    expect(cleanupDetailCrop(400,300,400*300-1)).toEqual({x:272,y:172,w:128,h:128});
    expect(cleanupDetailCrop(16,8,127)).toEqual({x:0,y:0,w:16,h:8});
  });
  it('maps horizontal and vertical scaling independently instead of assuming square source pixels',()=>{
    expect(mapCleanupSourceCrop({x:1,y:2,w:3,h:4},8,8,24,16)).toEqual({sourceWindow:{x:3,y:4,w:9,h:8},sourceCrop:{x:3,y:4,w:9,h:8}});
  });
  it('maps valid 50-million-pixel outputs and 100-million-pixel saved sources without allocating their grids',()=>{
    const crop=cleanupDetailCrop(10_000,5_000,49_999_999);
    expect(crop).toEqual({x:9872,y:4872,w:128,h:128});
    const mapped=mapCleanupSourceCrop(crop,10_000,5_000,2400,5700);
    expect(mapped.sourceCrop.x+mapped.sourceCrop.w).toBe(2400);
    expect(mapped.sourceCrop.y+mapped.sourceCrop.h).toBe(5700);
    expect(mapCleanupSourceCrop(crop,10_000,5_000,10_000,10_000).sourceCrop).toEqual({x:9872,y:9744,w:128,h:256});
    expect(()=>cleanupDetailCrop(10_001,10_000,0)).toThrow('valid image dimensions');
  });
  it('retains exact fractional boundaries and covers every nearest-sampled anchor in a noninteger resize',()=>{
    const crop={x:123,y:75,w:128,h:128},mapped=mapCleanupSourceCrop(crop,1478,667,2400,2850);
    expect(mapped.sourceWindow.x).toBeCloseTo(123*2400/1478,10);
    expect(mapped.sourceWindow.y).toBeCloseTo(75*2850/667,10);
    expect(mapped.sourceWindow.w).toBeCloseTo(128*2400/1478,10);
    expect(mapped.sourceWindow.h).toBeCloseTo(128*2850/667,10);
    for(let y=crop.y;y<crop.y+crop.h;y++)for(let x=crop.x;x<crop.x+crop.w;x++){
      const sx=Math.floor((x+.5)*2400/1478),sy=Math.floor((y+.5)*2850/667);
      expect(sx>=mapped.sourceCrop.x&&sx<mapped.sourceCrop.x+mapped.sourceCrop.w).toBe(true);
      expect(sy>=mapped.sourceCrop.y&&sy<mapped.sourceCrop.y+mapped.sourceCrop.h).toBe(true);
    }
    const bottomRight=mapCleanupSourceCrop({x:1350,y:539,w:128,h:128},1478,667,2400,2850);
    expect(bottomRight.sourceCrop.x+bottomRight.sourceCrop.w).toBe(2400);
    expect(bottomRight.sourceCrop.y+bottomRight.sourceCrop.h).toBe(2850);
  });
  it('reports coordinates in the original file without applying the import crop twice to pixel reads',()=>{
    const pixels=Uint8Array.from({length:20*10},(_,i)=>i),raster=encodeRaster(20,10,pixels);
    const detail=createSourceDetailPreview(raster,{x:2,y:1,w:3,h:2},10,5,{x:123,y:17});
    expect(detail.sourceCrop).toEqual({x:4,y:2,w:6,h:4});
    expect(detail.originalFileCrop).toEqual({x:127,y:19,w:6,h:4});
    expect(detail.pixels[0]).toBe(pixels[2*20+4]);
    expect(detail.pixels[detail.pixels.length-1]).toBe(pixels[5*20+9]);
  });
});

describe('bounded indexed source detail',()=>{
  it.each([1,2,3,4,5,16])('reads all base64 byte lanes and padding at a %i-pixel source tail',count=>{
    const pixels=Uint8Array.from({length:count},(_,i)=>(i*73+255)%256),raster=encodeRaster(count,1,pixels);
    const detail=createSourceDetailPreview(raster,{x:0,y:0,w:count,h:1},count,1);
    expect(detail.pixels).toEqual(pixels);expect(detail.sampled).toBe(false);
  });
  it('returns every source pixel in a native detail, even when output pixels combine several source cells',()=>{
    const pixels=Uint8Array.from({length:64},(_,i)=>i),raster=encodeRaster(8,8,pixels);
    const detail=createSourceDetailPreview(raster,{x:0,y:0,w:4,h:4},4,4);
    expect(detail).toMatchObject({width:8,height:8,sampled:false});expect(detail.pixels).toEqual(pixels);
  });
  it('bounds large detail previews and marks their sampling explicitly',()=>{
    const pixels=Uint8Array.from({length:200},(_,i)=>i),raster=encodeRaster(20,10,pixels);
    const detail=createSourceDetailPreview(raster,{x:0,y:0,w:10,h:10},10,10,undefined,4);
    expect(detail).toMatchObject({width:4,height:2,sampled:true,sourceCrop:{x:0,y:0,w:20,h:10},sourceWindow:{x:0,y:0,w:20,h:10}});
    expect(detail.pixels).toEqual(Uint8Array.from([42,47,52,57,142,147,152,157]));
    expect(detail.pixels.length).toBeLessThanOrEqual(SOURCE_DETAIL_MAX_SIDE**2);
  });
  it('retains at most four crop buffers and reuses matching clamped areas without decoding a full-source buffer',()=>{
    const raster=encodeRaster(1024,16,new Uint8Array(1024*16)),cache=new CleanupSourcePreviewCache(raster,1024,16);
    const first=cache.get(0),second=cache.get(200);cache.get(400);cache.get(600);
    expect(cache.get(0)).toBe(first);cache.get(800);
    expect(cache.get(0)).toBe(first);expect(cache.get(200)).not.toBe(second);
    expect(first.pixels.length).toBe(128*16);expect(cache.get(1)).toBe(first);
  });
  it('rejects invalid locations, crops, dimensions, offsets and unreadable sampled data',()=>{
    const raster=encodeRaster(8,8,new Uint8Array(64)),crop={x:0,y:0,w:8,h:8};
    for(const location of [-1,64,1.5,NaN])expect(()=>cleanupDetailCrop(8,8,location)).toThrow();
    expect(()=>mapCleanupSourceCrop({...crop,x:1},8,8,8,8)).toThrow('outside');
    expect(()=>createSourceDetailPreview(raster,crop,8,8,{x:-1,y:0})).toThrow('offset');
    expect(()=>createSourceDetailPreview(raster,crop,8,8,undefined,2048)).toThrow('preview limit');
    expect(()=>createSourceDetailPreview({...raster,pixelsBase64:'?' + raster.pixelsBase64.slice(1)},crop,8,8)).toThrow('invalid indexed');
    expect(()=>createSourceDetailPreview({...raster,pixelsBase64:''},crop,8,8)).toThrow('dimensions');
  });
});
