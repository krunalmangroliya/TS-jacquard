import type { IndexedImage, RGB, SourceImage } from './types';
export { encodeBmp } from './image-codec';
export const rgbHex=(rgb:RGB):string=>'#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join('');
export const hexRgb=(hex:string):RGB=>{if(!/^#[0-9a-f]{6}$/i.test(hex))throw new Error('Invalid color.');return[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)];};
export async function readImageFile(file:File,maxColors?:number):Promise<SourceImage>{
  if(file.size>110*1024*1024)throw new Error('Choose an image smaller than 110 MB.');
  const bytes=await file.arrayBuffer();
  return new Promise((resolve,reject)=>{const worker=new Worker(new URL('./import.worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=(e:MessageEvent<{source?:SourceImage;error?:string}>)=>{worker.terminate();if(e.data.source)resolve(e.data.source);else reject(new Error(e.data.error||'Import failed.'));};
    worker.onerror=(e)=>{worker.terminate();reject(new Error(e.message||'Image import failed.'));};worker.postMessage({bytes,name:file.name,maxColors},[bytes]);
  });
}
export function imageToCanvas(image:IndexedImage):HTMLCanvasElement{const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');if(!ctx)throw new Error('Canvas is unavailable.');const d=ctx.createImageData(image.width,image.height);for(let i=0;i<image.pixels.length;i++){const rgb=image.palette[image.pixels[i]];d.data[i*4]=rgb[0];d.data[i*4+1]=rgb[1];d.data[i*4+2]=rgb[2];d.data[i*4+3]=255;}ctx.putImageData(d,0,0);return c;}
export interface ExportReceipt{savedLocally:boolean;url:string}
export async function downloadBlob(blob:Blob,name:string):Promise<ExportReceipt>{
  let receipt:ExportReceipt|undefined;
  try{const response=await fetch('/__loom_export',{method:'POST',headers:{'Content-Type':blob.type,'X-Loom-Filename':encodeURIComponent(name)},body:blob});
    if(response.ok&&response.headers.get('Content-Type')?.includes('application/json'))receipt=await response.json() as ExportReceipt;
    else if(response.status!==404&&response.status!==405)throw new Error('Local export could not be saved. Please try again.');
  }catch(error){if(error instanceof TypeError)throw new Error('The local studio is disconnected. Start Loom Clean again, then retry your export.');throw error;}
  const url=receipt?.url||URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  if(!receipt)setTimeout(()=>URL.revokeObjectURL(url),30000);
  return receipt||{savedLocally:false,url};
}
export async function savePng(image:IndexedImage,name:string):Promise<ExportReceipt>{const canvas=imageToCanvas(image);const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG export failed.')),'image/png'));return downloadBlob(blob,name);}
