import { decodePng, decodeBmp, rgbaToIndexed } from './image-codec';
import type { SourceImage } from './types';
self.onmessage = async (event: MessageEvent<{bytes: ArrayBuffer; name: string; maxColors?: number}>) => {
  try {
    const {bytes,name,maxColors}=event.data;const b=new Uint8Array(bytes);let source:SourceImage;
    if(b[0]===137&&b[1]===80){const decoded=await decodePng(b),image=rgbaToIndexed(decoded,maxColors);source={...image,name,dpiX:decoded.dpiX,dpiY:decoded.dpiY};}
    else if(b[0]===66&&b[1]===77){const image=decodeBmp(b),v=new DataView(bytes),x=v.getInt32(38,true)*0.0254,y=v.getInt32(42,true)*0.0254;source={...image,name,originalColors:image.palette.length,dpiX:x>0?x:undefined,dpiY:y>0?y:undefined};}
    else throw new Error('Choose a PNG or uncompressed BMP image.');
    self.postMessage({source},{transfer:[source.pixels.buffer]});
  }catch(error){self.postMessage({error:error instanceof Error?error.message:'Could not read this image.'});}
};
