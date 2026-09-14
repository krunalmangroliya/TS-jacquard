import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { syntheticFixtures } from './fixtures';
import { encodePng } from '../../core/src/png';
import { DEFAULT_PROFILE, DEFAULT_RULES } from '../../core/src/types';
import { fillPlaceholders, renderMaster, traceFile } from './pipeline';
import { hash, writeJson } from './io';

const {values} = parseArgs({options:{update:{type:'boolean'},reason:{type:'string'},browser:{type:'boolean'},editor:{type:'boolean'}}});
async function main() {
  if(values.update && !values.reason?.trim()) throw new Error('Snapshot updates require --reason "reason for change"');
  const expected=path.resolve('eval/golden/expected'),actual=path.resolve('eval/golden/actual'),input=path.resolve('eval/golden/input');
  for(const dir of [expected,actual,input])await mkdir(dir,{recursive:true});
  let comparisons=0;const failures:string[]=[],metrics:unknown[]=[],browserCases=[];
  async function compare(name:string,bytes:Uint8Array) {
    await writeFile(path.join(actual,name),bytes);
    if(values.update){await writeFile(path.join(expected,name),bytes);comparisons++;return;}
    try {const old=await readFile(path.join(expected,name));if(!old.equals(Buffer.from(bytes)))failures.push(`${name}: bytes changed; inspect eval/golden/actual before accepting snapshots`);else comparisons++;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')failures.push(`${name}: missing expected output`);else throw error;}
  }
  for(const fixture of syntheticFixtures()) {
    const grid=new Uint8Array(fixture.raster.width*fixture.raster.height);for(let i=0;i<grid.length;i++)grid[i]=fixture.raster.data[i]<128?1:0;
    const source=encodePng(grid,fixture.raster.width,fixture.raster.height,{entries:[{index:0,name:'White',displayRgb:[255,255,255],exportRgb:[255,255,255]},{index:1,name:'Black',displayRgb:[0,0,0],exportRgb:[0,0,0]}]});
    const file=path.join(input,`${fixture.name}.png`);await writeFile(file,source);
    const traced=await traceFile(file,fixture.params),master=fillPlaceholders(traced.master);
    if(traced.report.faces<fixture.minFaces)failures.push(`${fixture.name}: expected at least ${fixture.minFaces} enclosed faces, got ${traced.report.faces}`);
    if(traced.report.openEnds.length>fixture.maxOpenEnds)failures.push(`${fixture.name}: ${traced.report.openEnds.length} open ends exceed budget ${fixture.maxOpenEnds}`);
    if(traced.report.nodes>2000)failures.push(`${fixture.name}: node budget exceeded`);
    await compare(`${fixture.name}.geometry.json`,new TextEncoder().encode(JSON.stringify({geometry:master.geometry,objects:master.objects},null,2)+'\n'));
    for(const widthPx of [48,96,192]) {
      const sizeInput={mode:'grid' as const,widthPx,linkAspect:true};
      const result=renderMaster(master,DEFAULT_PROFILE,sizeInput,DEFAULT_RULES),again=renderMaster(master,DEFAULT_PROFILE,sizeInput,DEFAULT_RULES);
      const stem=`${fixture.name}-${widthPx}x${result.heightPx}`;
      if(hash(result.bmp)!==hash(again.bmp))failures.push(`${stem}: Node rendering is nondeterministic`);
      await compare(`${stem}.bmp`,result.bmp);await compare(`${stem}.png`,result.png);
      metrics.push({name:fixture.name,widthPx,heightPx:result.heightPx,nodes:traced.report.nodes,faces:traced.report.faces,openEnds:traced.report.openEnds.length,traceMs:traced.traceMs,renderMs:result.renderMs,changedPixelsByRule:result.report.changedPixelsByRule,bmpSha256:hash(result.bmp)});
      browserCases.push({name:stem,master,profile:DEFAULT_PROFILE,sizeInput,rules:DEFAULT_RULES,expectedBmp:result.bmp});
    }
    console.log(`${fixture.name}: ${traced.report.faces} faces, ${traced.report.openEnds.length} open ends, ${traced.traceMs.toFixed(0)} ms trace`);
  }
  await writeJson(path.join(actual,'metrics.json'),metrics);
  if(values.update)await writeJson(path.join(expected,'baseline.json'),{kind:'Synthetic regression fixtures only; customer and NedGraphics acceptance pending',reason:values.reason,createdAt:new Date().toISOString(),cases:10,sizesPerCase:3});
  if(values.browser) {const {verifyBrowserDeterminism}=await import('./browser-check');const result=await verifyBrowserDeterminism(browserCases);console.log(`Browser worker equivalence: ${result.checked} outputs, ${result.browser}`);}
  if(values.editor) {const {installedBrowser}=await import('./browser-check');const {verifyStrokeEditorSmoke}=await import('./stroke-editor-check');const browser=await installedBrowser();const result=await verifyStrokeEditorSmoke(path.resolve('output/stroke-editor-smoke'),browser.executablePath);console.log(`Stroke editor: ${result.checks} browser checks passed; ${result.topologyBuilds} topology build.`);}
  if(failures.length)throw new Error(failures.join('\n'));
  console.log(`${comparisons} ${values.update?'baseline files written':'byte comparisons passed'}. Synthetic results do not establish cleanup savings or NedGraphics compatibility.`);
}
main().catch(error=>{console.error((error as Error).stack??String(error));process.exitCode=1;});
