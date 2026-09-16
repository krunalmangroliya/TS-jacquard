import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { decodePng, rgbaToIndexed, encodeBmp } from '../src/image-codec';
import { cleanRaster } from './engine-v1';
import { cleanGrainRegions } from '../src/texture-cleanup';
import type { CleanupOptions, IndexedImage } from '../src/types';
const source=rgbaToIndexed(await decodePng(await readFile('sample/42482pallu PSD FILE.png')));
const options:CleanupOptions={width:768,height:988,read:96,pick:52,strength:'balanced',flattenTexture:true,outlineColor:1,protectedColors:[],repeatX:false,repeatY:false};
const old=cleanRaster(source,options),start=performance.now(),noise=cleanGrainRegions(old.image,options);
const next={...old.image,pixels:noise.pixels};
const out='output/texture-v2';await mkdir(out,{recursive:true});await writeFile(out+'/cleaned.bmp',encodeBmp(next,96,52));
function png(im:IndexedImage){const p=new PNG({width:im.width,height:im.height});for(let i=0;i<im.pixels.length;i++)p.data.set([...im.palette[im.pixels[i]],255],i*4);return p;}
await writeFile(out+'/cleaned.png',PNG.sync.write(png(next)));
const crops=[{x:100,y:25,w:155,h:150},{x:284,y:345,w:155,h:150},{x:284,y:690,w:155,h:150}];
const scale=3,margin=12,sheet=new PNG({width:155*scale*2+margin*3,height:150*scale*3+margin*4});sheet.data.fill(28);
for(let a=3;a<sheet.data.length;a+=4)sheet.data[a]=255;
for(let row=0;row<crops.length;row++)for(let col=0;col<2;col++){const im=col?next:old.image,c=crops[row];for(let y=0;y<c.h*scale;y++)for(let x=0;x<c.w*scale;x++){const color=im.palette[im.pixels[(c.y+Math.floor(y/scale))*im.width+c.x+Math.floor(x/scale)]];sheet.data.set([...color,255],((margin+row*(c.h*scale+margin)+y)*sheet.width+margin+col*(c.w*scale+margin)+x)*4);}}
await writeFile(out+'/comparison.png',PNG.sync.write(sheet));
console.log(JSON.stringify({old:old.stats,addedNoiseChanges:noise.removedPixels,regions:noise.regions,noiseMs:performance.now()-start}));
