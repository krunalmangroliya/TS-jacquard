import type {RuleConfig} from '../../../packages/core/src/types';

/** Propose a gentle speck pass while retaining the designer's explicit scope. */
export function gentleCleanupRules(current:RuleConfig,maximumRegionPixels=1):RuleConfig {
  if(!Number.isInteger(maximumRegionPixels)||maximumRegionPixels<1||maximumRegionPixels>64)throw new Error('Choose a small-region limit from 1 to 64 pixels.');
  return {...current,minRegionPx:maximumRegionPixels+1,minThicknessPx:0,removeCheckerboard:false,connectVisibleEdges4:false,rasterResize:'nearest',repairOutlineGaps:false,outlineAlgorithm:'conservative'};
}

/** Change only line repair; keep existing sampling, speck rules and explicit scope. */
export function lineRepairRules(current:RuleConfig,colors:readonly number[],paletteSize:number):RuleConfig {
  if(colors.length<1||colors.length>8||new Set(colors).size!==colors.length||colors.some(color=>!Number.isInteger(color)||color<0||color>=paletteSize))throw new Error('Choose 1 to 8 different line colors.');
  return {...current,outlineAlgorithm:'conservative',repairOutlineGaps:true,repairColorIndices:[...colors].sort((a,b)=>a-b)};
}

export interface CleanupDifference {changedPixels:number;locations:number[];colorDeltas:number[]}
export const MAX_CLEANUP_REVIEW_AREAS=4096;
export function compareCleanupPixels(before:Uint8Array,after:Uint8Array,paletteSize:number,width:number):CleanupDifference {
  if(before.length!==after.length||!Number.isInteger(width)||width<1||before.length%width)throw new Error('Cleanup comparison requires the same pixel grid.');
  const colorDeltas=Array<number>(paletteSize).fill(0),locations:number[]=[],seen=new Set<number>();
  let changedPixels=0;
  // One review point per 64px tile, capped for a bounded review list.
  const tilesAcross=Math.ceil(width/64);
  for(let i=0;i<before.length;i++)if(before[i]!==after[i]){
    changedPixels++;colorDeltas[before[i]]--;colorDeltas[after[i]]++;
    const tile=Math.floor((i%width)/64)+Math.floor(Math.floor(i/width)/64)*tilesAcross;
    if(locations.length<MAX_CLEANUP_REVIEW_AREAS&&!seen.has(tile)){locations.push(i);seen.add(tile);}
  }
  return {changedPixels,locations,colorDeltas};
}

export function cleanupPreviewIsCurrent(sourceSequence:number,currentSequence:number,pending:boolean):boolean {
  return !pending&&sourceSequence===currentSequence;
}
