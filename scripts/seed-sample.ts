import {readFile} from 'node:fs/promises';
import {PNG} from 'pngjs';
const base='http://127.0.0.1:4317',directory='output/stroke-trial/sample-1-bb1795';
const existing=await fetch(base+'/api/designs').then(r=>r.json()) as {id:string;tags:string[]}[];
if(existing.some(record=>record.tags.includes('supplied-sample'))){console.log('Supplied sample already exists in the library.');process.exit(0);}
const master=JSON.parse(await readFile(`${directory}/master.json`,'utf8'));master.name='Sample 1 · floral panel';master.tags=['supplied-sample','pallu','test colors'];
const source=await readFile('sample-input/sample-1.png'),preview=PNG.sync.read(await readFile(`${directory}/size-1200px.png`));
const thumb=new PNG({width:240,height:358});for(let y=0;y<thumb.height;y++)for(let x=0;x<thumb.width;x++){const p=(Math.floor(y/thumb.height*preview.height)*preview.width+Math.floor(x/thumb.width*preview.width))*4;preview.data.copy(thumb.data,(y*thumb.width+x)*4,p,p+4);}
const response=await fetch(base+'/api/designs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({master,name:master.name,sourcePngBase64:source.toString('base64'),thumbnailPngBase64:PNG.sync.write(thumb).toString('base64')})});
if(!response.ok)throw new Error(await response.text());const saved=await response.json() as {id:string};console.log(`Seeded ${base}/#/design/${saved.id}`);
