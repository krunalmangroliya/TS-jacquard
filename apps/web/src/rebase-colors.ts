import type {DesignRecord} from '../../../packages/app-model/src/index';
import type {Master,Palette} from '../../../packages/core/src/types';

type PaletteEntry=Palette['entries'][number];
const identity=(entry:PaletteEntry):string=>JSON.stringify([entry.name,entry.displayRgb,entry.exportRgb]);
const guidance='Keep this size on its existing master, or create a new size from the updated master and choose its cleanup colors again.';

/** Compare against the master after local operations are replayed, not the raw parent palette. */
export function rebaseColorReferences(variant:DesignRecord,master:Master):Pick<DesignRecord,'rules'|'pixelOverrides'> {
  const previous=variant.master.palette.entries,next=master.palette.entries;
  const references=new Set([
    ...(variant.rules.protectedColorIndices??[]),
    ...(variant.rules.cleanupColorIndices??[]),
    ...(variant.rules.repairColorIndices??[]),
    ...(variant.rules.outlineColorIndex===undefined?[]:[variant.rules.outlineColorIndex]),
  ]);
  for(const pixel of variant.pixelOverrides)references.add(pixel.colorIndex);
  // Exact unchanged order is reliable even for intentionally duplicate colors.
  const unchanged=previous.length===next.length&&previous.every((entry,index)=>identity(entry)===identity(next[index]));
  const destinations=new Map<string,number[]>();
  for(const entry of next){const key=identity(entry),indices=destinations.get(key)??[];indices.push(entry.index);destinations.set(key,indices);}
  const mapping=new Map<number,number>();
  for(const index of references){
    const original=previous[index];
    if(!original)throw new Error(`Referenced color ${index} is missing from this size. ${guidance}`);
    if(unchanged){mapping.set(index,index);continue;}
    // Ground is a reserved slot, not a motif color that can move with the palette.
    if(index===0){
      if(!next[0]||identity(next[0])!==identity(original))throw new Error(`The updated master's ground color has changed. ${guidance}`);
      mapping.set(0,0);continue;
    }
    const matches=destinations.get(identity(original))??[];
    if(matches.length!==1||matches[0]===0){
      const reason=matches.length>1?'has multiple identical matches':matches[0]===0?'now matches only the reserved ground slot':'is missing or has been recolored';
      throw new Error(`Color ${index} (${original.name}) ${reason} in the updated master. ${guidance}`);
    }
    mapping.set(index,matches[0]);
  }
  const remap=(index:number):number=>mapping.get(index)!;
  const remapList=(indices:number[]):number[]=>[...new Set(indices.map(remap))].sort((a,b)=>a-b);
  const overridesChanged=variant.pixelOverrides.some(pixel=>remap(pixel.colorIndex)!==pixel.colorIndex);
  return {
    rules:{...variant.rules,
      ...(variant.rules.protectedColorIndices===undefined?{}:{protectedColorIndices:remapList(variant.rules.protectedColorIndices)}),
      ...(variant.rules.cleanupColorIndices===undefined?{}:{cleanupColorIndices:remapList(variant.rules.cleanupColorIndices)}),
      ...(variant.rules.repairColorIndices===undefined?{}:{repairColorIndices:remapList(variant.rules.repairColorIndices)}),
      ...(variant.rules.outlineColorIndex===undefined?{}:{outlineColorIndex:remap(variant.rules.outlineColorIndex)}),
    },
    pixelOverrides:overridesChanged?variant.pixelOverrides.map(pixel=>({...pixel,colorIndex:remap(pixel.colorIndex)})):variant.pixelOverrides,
  };
}
