import {applyOperation} from '../../../packages/core/src/ops';
import type {DesignRecord} from '../../../packages/app-model/src/index';
import type {Master} from '../../../packages/core/src/types';
self.onmessage=({data}:{data:{variant:DesignRecord;parent:Master}})=>{
  try{let master=structuredClone(data.parent);const operations:DesignRecord['operations']=[],warnings:string[]=[];
    for(const [i,operation]of data.variant.operations.entries())try{const applied=applyOperation(master,operation);master=applied.master;operations.push(operation);warnings.push(...applied.warnings);}catch(error){warnings.push(`Edit ${i+1} (${operation.t}) could not be reapplied: ${(error as Error).message}`);}
    const variant={...data.variant,master,operations,baseMasterVersion:data.parent.version};
    if(data.variant.pixelOverrides.some(p=>p.colorIndex>=master.palette.entries.length))throw new Error('The newer palette does not contain all pixel override colors. Keep the old base or clear/remap those overrides first.');
    if(data.variant.rules.protectedColorIndices?.some(index=>index>=master.palette.entries.length))throw new Error('A protected cleanup color is missing from the newer palette. Update the protected colors before rebasing.');
    warnings.unshift(`${operations.length} of ${data.variant.operations.length} edits reapplied. Pixel corrections and size settings are retained.`);
    self.postMessage({document:variant,warnings:[...new Set(warnings)]});
  }catch(error){self.postMessage({error:(error as Error).message});}
};
