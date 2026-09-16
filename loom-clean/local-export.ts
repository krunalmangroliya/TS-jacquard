import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Loopback studio convenience: keep an actual export even when embedded browsers block blob downloads. */
export function localExports():Plugin{
  let directory='';
  const middleware=async(req:IncomingMessage,res:ServerResponse,next:()=>void)=>{
    const requestPath=(req.url||'').split('?')[0];
    if(!requestPath.startsWith('/__loom_export'))return next();
    const send=(status:number,value:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    try{
      if(req.method==='POST'&&requestPath==='/__loom_export'){
        const origin=req.headers.origin;
        if(origin&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`)return send(403,{error:'Use the local studio to export.'});
        const requested=decodeURIComponent(String(req.headers['x-loom-filename']||''));
        const extension=path.extname(requested).toLowerCase();
        if(!['.bmp','.png'].includes(extension))return send(400,{error:'Only BMP and PNG exports are accepted.'});
        const clean=path.basename(requested,extension).replace(/[^a-zA-Z0-9_.-]/g,'-').slice(0,90)||'design';
        const filename=`${Date.now()}-${randomUUID().slice(0,8)}-${clean}${extension}`;
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>20*1024*1024)return send(413,{error:'Export exceeds 20 MB.'});chunks.push(bytes);}
        const bytes=Buffer.concat(chunks);
        if(extension==='.bmp'&&(bytes.length<54||bytes[0]!==66||bytes[1]!==77))return send(400,{error:'Invalid BMP data.'});
        if(extension==='.png'&&(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))return send(400,{error:'Invalid PNG data.'});
        await mkdir(directory,{recursive:true});await writeFile(path.join(directory,filename),bytes,{flag:'wx'});
        return send(201,{url:`/__loom_export/${encodeURIComponent(filename)}`,savedLocally:true});
      }
      if(req.method==='GET'&&requestPath.startsWith('/__loom_export/')){
        const filename=decodeURIComponent(requestPath.slice('/__loom_export/'.length));
        if(path.basename(filename)!==filename||!/^\d{13}-[a-f0-9]{8}-[a-zA-Z0-9_.-]+\.(bmp|png)$/.test(filename))return send(404,{error:'Export not found.'});
        const bytes=await readFile(path.join(directory,filename));
        res.setHeader('Content-Type',filename.endsWith('.bmp')?'image/bmp':'image/png');
        res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);res.setHeader('Cache-Control','no-store');res.end(bytes);return;
      }
      send(405,{error:'Unsupported export request.'});
    }catch(error){send((error as NodeJS.ErrnoException).code==='ENOENT'?404:500,{error:'Could not save or retrieve this local export.'});}
  };
  return{name:'loom-local-exports',configResolved(config){directory=path.resolve(config.root,'output','exports');},configureServer(server){server.middlewares.use(middleware);},configurePreviewServer(server){server.middlewares.use(middleware);}};
}
