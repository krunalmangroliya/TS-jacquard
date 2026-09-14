import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readJson } from './io';
import { validateMaster } from '../../core/src/schemas';
import type { TraceReport } from '../../core/src/types';
import { writeReview, type ReviewOutput } from './review';
import { z } from 'zod';
const recordSchema=z.object({widthPx:z.number().int().positive(),heightPx:z.number().int().positive(),widthIn:z.number().finite().positive(),heightIn:z.number().finite().positive(),changedPixelsByRule:z.record(z.number().int().nonnegative()),colorsUsed:z.array(z.number().int()),smallFacesRemoved:z.array(z.object({x:z.number().finite(),y:z.number().finite()})),warnings:z.array(z.string())});

/** Refresh report layout from existing verified exports without retracing customer artwork. */
async function main(){
  const directory=path.resolve(process.argv[2]??'output/samples');
  const master=validateMaster(await readJson(path.join(directory,'master.json')));
  const trace=await readJson(path.join(directory,'trace-report.json')) as TraceReport;
  const files=(await readdir(directory)).filter(f=>/^size-.*\.json$/.test(f));
  const outputs:ReviewOutput[]=[];
  for(const file of files){const record=recordSchema.parse(await readJson(path.join(directory,file)));outputs.push({...record,stem:path.join(directory,file.slice(0,-5)),report:record});}
  outputs.sort((a,b)=>a.widthPx-b.widthPx);
  await writeReview(directory,master,trace,outputs,process.argv.includes('--generated'));
  console.log(`Refreshed ${path.join(directory,'review.html')}`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
