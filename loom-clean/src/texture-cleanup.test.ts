import { describe, expect, it } from 'vitest';
import { cleanGrainRegions } from './texture-cleanup';
import type { CleanupOptions, IndexedImage } from './types';
const options = (w: number, h: number, extra: Partial<CleanupOptions> = {}): CleanupOptions => ({width:w,height:h,read:96,pick:52,strength:'balanced',flattenTexture:true,outlineColor:1,protectedColors:[],repeatX:false,repeatY:false,...extra});
const raster = (w=61,h=61): IndexedImage => ({width:w,height:h,pixels:new Uint8Array(w*h),palette:[[230,190,0],[0,0,128],[240,0,140],[0,160,0]]});
const ink = (im:IndexedImage,x:number,y:number,c=2) => { im.pixels[y*im.width+x]=c; };
function field() { const im=raster(); let seed=179; for(let y=5;y<56;y++)for(let x=5;x<56;x++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;if(seed%100<23)ink(im,x,y);}return im; }
describe('grain field detection',()=>{
  it('removes a diagonally connected grain network without requiring eight-connected isolation',()=>{
    const im=field(), before=im.pixels.slice();
    const out=cleanGrainRegions(im,options(im.width,im.height));
    expect(out.removedPixels).toBeGreaterThan(300);
    expect(im.pixels).toEqual(before);
    expect(out.pixels.length).toBe(im.pixels.length);
    expect(out.removedPixels).toBe(out.mask.reduce((a,b)=>a+b,0));
  });
  it('keeps solid ornaments, one-pixel hatching and an enclosed ring center inside the field',()=>{
    const im=field();
    for(let y=10;y<=16;y++)for(let x=10;x<=16;x++)ink(im,x,y,3);
    for(let x=32;x<=51;x++)ink(im,x,39,3);
    for(let y=24;y<=30;y++)for(let x=24;x<=30;x++)ink(im,x,y,3);
    for(let y=26;y<=28;y++)for(let x=26;x<=28;x++)ink(im,x,y,0);
    ink(im,27,27,2);
    const out=cleanGrainRegions(im,options(61,61));
    for(let y=10;y<=16;y++)for(let x=10;x<=16;x++)expect(out.pixels[y*61+x]).toBe(3);
    for(let x=32;x<=51;x++)expect(out.pixels[39*61+x]).toBe(3);
    expect(out.pixels[27*61+27]).toBe(2);
    expect(out.removedPixels).toBeGreaterThan(100);
  });
  it('preserves smooth boundaries and sparse intentional dots when there is no grain field',()=>{
    const im=raster();for(let y=10;y<50;y++)for(let x=10;x<30;x++)ink(im,x,y);
    ink(im,45,10);ink(im,45,25);ink(im,45,40);
    const out=cleanGrainRegions(im,options(61,61));expect(out.pixels).toEqual(im.pixels);
  });
  it.each([2,3,4,5,6,7,8])('preserves an eight-connected thin circular contour of radius %i inside grain',radius=>{
    const im=field(),points=new Set<number>();let x=radius,y=0,error=1-x;
    while(x>=y){for(const[dx,dy]of[[x,y],[y,x],[-y,x],[-x,y],[-x,-y],[-y,-x],[y,-x],[x,-y]]){const i=(30+dy)*61+30+dx;points.add(i);im.pixels[i]=3;}y++;if(error<0)error+=2*y+1;else{x--;error+=2*(y-x)+1;}}
    const out=cleanGrainRegions(im,options(61,61));for(const i of points)expect(out.pixels[i]).toBe(3);
    expect(out.removedPixels).toBeGreaterThan(250);
  });
  it('preserves several thin curved hatch lines with diagonal connections',()=>{
    const im=field(),points=new Set<number>();
    for(let row=0;row<3;row++)for(let x=10;x<=50;x++){const y=15+row*10+Math.round(3*Math.sin(x*.3));const i=y*61+x;points.add(i);im.pixels[i]=3;}
    const out=cleanGrainRegions(im,options(61,61));for(const i of points)expect(out.pixels[i]).toBe(3);
    expect(out.removedPixels).toBeGreaterThan(100);
  });
  it('preserves a thin circular contour across a repeating edge',()=>{
    const im=field(),points=new Set<number>();let x=4,y=0,error=1-x;
    while(x>=y){for(const[dx,dy]of[[x,y],[y,x],[-y,x],[-x,y],[-x,-y],[-y,-x],[y,-x],[x,-y]]){const i=(30+dy)*61+(dx+61)%61;points.add(i);im.pixels[i]=3;}y++;if(error<0)error+=2*y+1;else{x--;error+=2*(y-x)+1;}}
    const out=cleanGrainRegions(im,options(61,61,{repeatX:true}));for(const i of points)expect(out.pixels[i]).toBe(3);
  });
  it('gives the same result when a repeating grain tile is shifted across its seam',()=>{
    const im=field(),shifted={...im,pixels:new Uint8Array(im.pixels.length)},dx=23,dy=17;
    for(let y=0;y<61;y++)for(let x=0;x<61;x++)shifted.pixels[((y+dy)%61)*61+(x+dx)%61]=im.pixels[y*61+x];
    const opts=options(61,61,{repeatX:true,repeatY:true});
    const a=cleanGrainRegions(im,opts),b=cleanGrainRegions(shifted,opts);
    for(let y=0;y<61;y++)for(let x=0;x<61;x++)expect(a.pixels[y*61+x]).toBe(b.pixels[((y+dy)%61)*61+(x+dx)%61]);
  });
  it('never changes protected inks or adds a protected replacement',()=>{
    for(const protectedColors of [[0],[2]]){const im=field();const out=cleanGrainRegions(im,options(61,61,{protectedColors}));expect(out.pixels).toEqual(im.pixels);}
  });
  it('can remove grain from a broad background that shares the outline ink',()=>{
    const im=field();for(let i=0;i<im.pixels.length;i++)if(im.pixels[i]===0)im.pixels[i]=1;
    const out=cleanGrainRegions(im,options(61,61));expect(out.removedPixels).toBeGreaterThan(300);
    for(let i=0;i<im.pixels.length;i++)if(im.pixels[i]===1)expect(out.pixels[i]).toBe(1);
    expect(cleanGrainRegions(im,options(61,61,{protectedColors:[1]})).pixels).toEqual(im.pixels);
  });
  it('is disabled explicitly and is deterministic',()=>{
    const im=field();expect(cleanGrainRegions(im,options(61,61,{flattenTexture:false})).pixels).toEqual(im.pixels);
    expect(cleanGrainRegions(im,options(61,61)).pixels).toEqual(cleanGrainRegions(im,options(61,61)).pixels);
  });
});
