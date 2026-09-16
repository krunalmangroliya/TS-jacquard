import {applyOperation} from '../../../packages/core/src/ops';
import type {DesignRecord} from '../../../packages/app-model/src/index';
import type {Master} from '../../../packages/core/src/types';
import {rebaseColorReferences} from './rebase-colors';
self.onmessage=({data}:{data:{variant:DesignRecord;parent:Master}})=>{
  try{let master=structuredClone(data.parent);const operations:DesignRecord['operations']=[],warnings:string[]=[];
    for(const [i,operation]of data.variant.operations.entries())try{const applied=applyOperation(master,operation);master=applied.master;operations.push(operation);warnings.push(...applied.warnings);}catch(error){warnings.push(`Edit ${i+1} (${operation.t}) could not be reapplied: ${(error as Error).message}`);}
    const references=rebaseColorReferences(data.variant,master);
    const variant={...data.variant,...references,master,operations,baseMasterVersion:data.parent.version};
    warnings.unshift(`${operations.length} of ${data.variant.operations.length} edits reapplied. Pixel corrections and size settings are retained.`);
    self.postMessage({document:variant,warnings:[...new Set(warnings)]});
  }catch(error){self.postMessage({error:(error as Error).message});}
};
