import { cleanRaster } from './engine';
import type { CleanupOptions, IndexedImage } from './types';
self.onmessage=(event:MessageEvent<{source:IndexedImage;options:CleanupOptions}>)=>{
  try{const result=cleanRaster(event.data.source,event.data.options,progress=>self.postMessage({progress}));self.postMessage({result},{transfer:[...new Set([result.image.pixels.buffer,result.baseline.buffer,result.changes.buffer])]});}
  catch(error){self.postMessage({error:error instanceof Error?error.message:'Cleanup failed.'});}
};
