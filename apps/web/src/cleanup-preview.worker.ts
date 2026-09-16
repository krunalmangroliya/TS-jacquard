import {EditorEngine} from './editor-engine';
import {compareCleanupPixels} from './cleanup-preview';
import type {DesignRecord} from '../../../packages/app-model/src/index';
import type {MachineProfile,RuleConfig} from '../../../packages/core/src/types';
import type {EditorRender} from './editor-protocol';
import type {CleanupDifference} from './cleanup-preview';
import {CleanupSourcePreviewCache,type SourceDetailPreview} from './cleanup-source-preview';

export interface CleanupPreviewResult {render:EditorRender;difference:CleanupDifference}
export type CleanupPreviewRequest=
  | {type:'preview';document:DesignRecord;profile:MachineProfile;rules:RuleConfig;before:Pick<EditorRender,'grid'|'widthPx'|'heightPx'>}
  | {type:'source-detail';requestId:number;location:number};
export type CleanupPreviewReply=
  | ({type:'preview'}&CleanupPreviewResult)
  | {type:'source-detail';requestId:number;detail:SourceDetailPreview}
  | {type:'error';scope:'preview'|'source-detail';requestId?:number;error:string};
let sourceCache:CleanupSourcePreviewCache|undefined;
self.onmessage=({data}:{data:CleanupPreviewRequest})=>{
  try{
    if(data.type==='source-detail'){
      if(!sourceCache)throw new Error('Prepare the cleanup comparison before viewing source detail.');
      if(!Number.isSafeInteger(data.requestId)||data.requestId<1)throw new Error('Source detail request is invalid.');
      const cached=sourceCache.get(data.location),detail={...cached,pixels:cached.pixels.slice()};
      self.postMessage({type:'source-detail',requestId:data.requestId,detail} satisfies CleanupPreviewReply,{transfer:[detail.pixels.buffer]});
      return;
    }
    sourceCache=undefined;
    if(data.document.kind!=='size'||!data.document.master.raster)throw new Error('Create an image size before previewing cleanup.');
    const engine=new EditorEngine();
    const reply=engine.handle({type:'init',requestId:1,document:{...data.document,rules:data.rules},profile:data.profile});
    if(reply.type!=='ready')throw new Error('Cleanup preview could not render.');
    if(data.before.widthPx!==reply.render.widthPx||data.before.heightPx!==reply.render.heightPx)throw new Error('Cleanup comparison requires the same pixel dimensions.');
    const difference=compareCleanupPixels(data.before.grid,reply.render.grid,data.document.master.palette.entries.length,reply.render.widthPx);
    sourceCache=new CleanupSourcePreviewCache(data.document.master.raster,reply.render.widthPx,reply.render.heightPx,data.document.master.source.crop);
    self.postMessage({type:'preview',render:reply.render,difference} satisfies CleanupPreviewReply,{transfer:[reply.render.grid.buffer,reply.render.changedPixelsMask.buffer]});
  }catch(error){self.postMessage({type:'error',scope:data.type==='source-detail'?'source-detail':'preview',...(data.type==='source-detail'?{requestId:data.requestId}:{}),error:(error as Error).message} satisfies CleanupPreviewReply);}
};
