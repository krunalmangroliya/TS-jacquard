import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

function canonical(file:string):string {
  const absolute=path.resolve(file);
  const resolved=existsSync(absolute)?realpathSync(absolute):absolute;
  return process.platform==='win32'?resolved.toLowerCase():resolved;
}
export function assertOutputPaths(outputs:string[],inputs:string[]):void {
  const sources=new Set(inputs.map(canonical)),seen=new Set<string>();
  for(const output of outputs){
    const key=canonical(output);
    if(sources.has(key))throw new Error(`Output would overwrite an input file: ${output}`);
    if(seen.has(key))throw new Error(`Two outputs resolve to the same file: ${output}`);
    seen.add(key);
  }
}
export function jsonOutput(input:string,requested:string|undefined,suffix:string):string {
  if(requested&&!/\.json$/i.test(requested))throw new Error('Master output must have a .json extension');
  return requested??`${input}.${suffix}.json`;
}
export function exportPaths(requested:string):string[]{const stem=requested.replace(/\.(bmp|png|json)$/i,'');return [`${stem}.bmp`,`${stem}.png`,`${stem}.json`,`${stem}.changes.png`];}
