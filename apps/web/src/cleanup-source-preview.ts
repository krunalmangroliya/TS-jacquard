import type {IndexedRaster} from '../../../packages/core/src/types';
import {MAX_RASTER_PIXELS} from '../../../packages/core/src/raster';

export interface PreviewCrop {x:number;y:number;w:number;h:number}
export interface SourceDetailPreview {
  outputCrop:PreviewCrop;
  /** Exact output-cell coverage in the stored, already-cropped raster. */
  sourceWindow:PreviewCrop;
  /** Whole source pixels that cover the exact fractional window. */
  sourceCrop:PreviewCrop;
  originalFileCrop:PreviewCrop;
  pixels:Uint8Array;
  width:number;
  height:number;
  sampled:boolean;
}
export const SOURCE_DETAIL_MAX_SIDE=1024;
const BASE64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES=new Int16Array(128).fill(-1);
for(let i=0;i<BASE64.length;i++)VALUES[BASE64.charCodeAt(i)]=i;

function dimensions(width:number,height:number):void {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>MAX_RASTER_PIXELS)throw new Error('Source detail needs valid image dimensions.');
}

/** Shared by all three panes so output and source stay on the same area. */
export function cleanupDetailCrop(width:number,height:number,location:number):PreviewCrop {
  dimensions(width,height);
  if(!Number.isSafeInteger(location)||location<0||location>=width*height)throw new Error('Source detail location is outside the output.');
  const w=Math.min(128,width),h=Math.min(128,height);
  return{x:Math.max(0,Math.min(width-w,location%width-Math.floor(w/2))),y:Math.max(0,Math.min(height-h,Math.floor(location/width)-Math.floor(h/2))),w,h};
}

export function mapCleanupSourceCrop(output:PreviewCrop,outputWidth:number,outputHeight:number,sourceWidth:number,sourceHeight:number):{sourceWindow:PreviewCrop;sourceCrop:PreviewCrop} {
  dimensions(outputWidth,outputHeight);dimensions(sourceWidth,sourceHeight);
  if(!Object.values(output).every(Number.isSafeInteger)||output.x<0||output.y<0||output.w<1||output.h<1||output.x+output.w>outputWidth||output.y+output.h>outputHeight)throw new Error('Source detail crop is outside the output.');
  const x=output.x*sourceWidth/outputWidth,y=output.y*sourceHeight/outputHeight,right=(output.x+output.w)*sourceWidth/outputWidth,bottom=(output.y+output.h)*sourceHeight/outputHeight;
  const leftPixel=Math.floor(x),topPixel=Math.floor(y),rightPixel=Math.min(sourceWidth,Math.ceil(right)),bottomPixel=Math.min(sourceHeight,Math.ceil(bottom));
  return{sourceWindow:{x,y,w:right-x,h:bottom-y},sourceCrop:{x:leftPixel,y:topPixel,w:rightPixel-leftPixel,h:bottomPixel-topPixel}};
}

function base64Value(text:string,index:number):number {
  const value=VALUES[text.charCodeAt(index)]??-1;
  if(value<0)throw new Error('Source detail contains invalid indexed pixels.');
  return value;
}
/** Random access avoids decoding or copying the full source for a small detail. */
function indexedPixel(text:string,index:number):number {
  const lane=index%3,group=Math.floor(index/3)*4;
  const a=base64Value(text,group+lane),b=base64Value(text,group+lane+1);
  return lane===0?(a<<2)|(b>>>4):lane===1?((a&15)<<4)|(b>>>2):((a&3)<<6)|b;
}

export function createSourceDetailPreview(raster:IndexedRaster,outputCrop:PreviewCrop,outputWidth:number,outputHeight:number,originalOffset:{x:number;y:number}={x:0,y:0},maxSide=SOURCE_DETAIL_MAX_SIDE):SourceDetailPreview {
  dimensions(raster.width,raster.height);
  if(typeof raster.pixelsBase64!=='string'||raster.pixelsBase64.length!==Math.ceil(raster.width*raster.height/3)*4)throw new Error('Source detail pixels do not match the source dimensions.');
  if(!Number.isSafeInteger(maxSide)||maxSide<1||maxSide>SOURCE_DETAIL_MAX_SIDE)throw new Error('Source detail exceeds its preview limit.');
  if(!Number.isSafeInteger(originalOffset.x)||!Number.isSafeInteger(originalOffset.y)||originalOffset.x<0||originalOffset.y<0)throw new Error('Source crop offset must use whole pixels.');
  const {sourceWindow,sourceCrop}=mapCleanupSourceCrop(outputCrop,outputWidth,outputHeight,raster.width,raster.height);
  const scale=Math.min(1,maxSide/sourceCrop.w,maxSide/sourceCrop.h),width=Math.max(1,Math.round(sourceCrop.w*scale)),height=Math.max(1,Math.round(sourceCrop.h*scale));
  const pixels=new Uint8Array(width*height);
  for(let y=0;y<height;y++){
    const sy=sourceCrop.y+Math.min(sourceCrop.h-1,Math.floor((y+.5)*sourceCrop.h/height));
    for(let x=0;x<width;x++){
      const sx=sourceCrop.x+Math.min(sourceCrop.w-1,Math.floor((x+.5)*sourceCrop.w/width));
      pixels[y*width+x]=indexedPixel(raster.pixelsBase64,sy*raster.width+sx);
    }
  }
  return{outputCrop:{...outputCrop},sourceWindow,sourceCrop,originalFileCrop:{...sourceCrop,x:sourceCrop.x+originalOffset.x,y:sourceCrop.y+originalOffset.y},pixels,width,height,sampled:width!==sourceCrop.w||height!==sourceCrop.h};
}

/** At most four bounded crops live in a review worker; no decoded full-source cache. */
export class CleanupSourcePreviewCache {
  private readonly cache=new Map<string,SourceDetailPreview>();
  constructor(private readonly raster:IndexedRaster,private readonly outputWidth:number,private readonly outputHeight:number,private readonly originalOffset:{x:number;y:number}={x:0,y:0}){}
  get(location:number):SourceDetailPreview {
    const crop=cleanupDetailCrop(this.outputWidth,this.outputHeight,location),key=`${crop.x},${crop.y},${crop.w},${crop.h}`;
    const cached=this.cache.get(key);
    if(cached){this.cache.delete(key);this.cache.set(key,cached);return cached;}
    const detail=createSourceDetailPreview(this.raster,crop,this.outputWidth,this.outputHeight,this.originalOffset);
    this.cache.set(key,detail);
    if(this.cache.size>4)this.cache.delete(this.cache.keys().next().value!);
    return detail;
  }
}
