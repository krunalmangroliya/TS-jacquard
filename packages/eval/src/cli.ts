import { parseArgs } from 'node:util';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PROFILE, DEFAULT_RULES, type SizeInput, type TraceParams } from '../../core/src/types';
import { profileSchema, ruleSchema, validateMaster } from '../../core/src/schemas';
import { exportMaster, fillPlaceholders, traceFile } from './pipeline';
import { readJson, writeJson, slug, hash, escapeHtml } from './io';
import { masterSvg, writeReview } from './review';
import { assertOutputPaths, exportPaths, jsonOutput } from './paths';
import { applyOperation, type Operation } from '../../core/src/ops';
import { writeStrokeEditor } from './stroke-editor';
import { z } from 'zod';
const sampleSettingsSchema=z.object({threshold:z.number().min(0).max(255).optional(),gapClosePx:z.number().finite().nonnegative().optional(),repeat:z.enum(['none','straight']).optional(),widthsPx:z.array(z.number().int().positive()).min(1).max(6).optional(),note:z.string().optional()});

const HELP = `JDM — core pipeline prototype

  pnpm jdm trace in.png --out master.json [--threshold 128] [--gap-close 2]
  pnpm jdm fill master.json --auto-placeholders --out colored.json
  pnpm jdm apply master.json --ops edits.json --out edited.json
  pnpm jdm inspect master.json --width-px 1200 --out output/editor
  pnpm jdm render colored.json --profile profile.json --width-in 2.5 --out out.bmp
  pnpm jdm render colored.json --width-px 150 --height-px 96 --out out.bmp
  pnpm sample [--input-dir sample-input] [--out output/samples] [--profile profile.json]
  pnpm sample --sizes-px 300,1200,2400 --gap-close 0 --repeat none
  pnpm eval [--update] [--browser]

No customer PNGs? sample uses eval/references/generated-paisley.png.
sample writes a review.html, vector master, 3 sizes, BMPs, PNGs and JSON reports.
Automatic fill is test coloring only, not yarn or weave assignment.
Use --rules rules.json to configure small-region removal/protected colors.
Use --overrides overrides.json for final pixel corrections.
Source files are never modified. Machine defaults are unverified placeholders.
`;
const parsed = parseArgs({ allowPositionals: true, options: {
  out: { type:'string' }, profile:{type:'string'}, rules:{type:'string'}, overrides:{type:'string'}, ops:{type:'string'},
  'width-in':{type:'string'}, 'height-in':{type:'string'}, 'width-px':{type:'string'}, 'height-px':{type:'string'},
  'fit-across':{type:'string'}, 'input-dir':{type:'string'}, 'sizes-px':{type:'string'}, threshold:{type:'string'}, 'gap-close':{type:'string'},
  'auto-placeholders':{type:'boolean'}, help:{type:'boolean'}, repeat:{type:'string'},
} });
const { values, positionals } = parsed;
const numeric = (key: keyof typeof values): number | undefined => {
  const value = values[key]; if (value === undefined) return undefined;
  const result = Number(value); if (typeof value !== 'string' || !value.trim() || !Number.isFinite(result)) throw new Error(`--${key} must be a number`); return result;
};
async function main() {
  if (values.help || !positionals[0]) { console.log(HELP); return; }
  const command = positionals[0], input = positionals[1];
  if(!['sample','trace','fill','apply','render','inspect'].includes(command))throw new Error(`Unknown command: ${command}`);
  const sizeModes=[values['fit-across']!==undefined,values['width-px']!==undefined||values['height-px']!==undefined,values['width-in']!==undefined||values['height-in']!==undefined];
  if(sizeModes.filter(Boolean).length>1)throw new Error('Choose one size mode: physical dimensions, grid dimensions, or fit-across');
  const protectedInputs=[input,values.profile,values.rules,values.overrides,values.ops].filter((v):v is string=>v!==undefined);
  const profile = values.profile ? profileSchema.parse(await readJson(values.profile)) : DEFAULT_PROFILE;
  const rules = values.rules ? ruleSchema.parse(await readJson(values.rules)) : DEFAULT_RULES;
  if(values.repeat!==undefined&&!['none','straight'].includes(values.repeat))throw new Error('--repeat must be none (panel) or straight (repeat unit)');
  const repeat={type:(values.repeat??'straight') as 'none'|'straight'};
  const params: Partial<TraceParams> = {};
  if (values.threshold !== undefined) params.threshold = numeric('threshold');
  if (values['gap-close'] !== undefined) params.gapClosePx = numeric('gap-close');
  if (command === 'sample') {
    const widths=values['sizes-px']?.split(',').map(s=>Number(s.trim()));
    if(widths&&(!widths.length||widths.length>6||widths.some(n=>!Number.isSafeInteger(n)||n<1)))throw new Error('--sizes-px needs one to six positive integer widths, separated by commas');
    const folder = path.resolve(values['input-dir'] ?? 'sample-input');
    let files: string[] = [];
    try { files = (await readdir(folder, { withFileTypes: true })).filter(f => f.isFile() && /\.png$/i.test(f.name)).map(f => path.join(folder,f.name)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || values['input-dir']) throw error; }
    const isGenerated = files.length === 0;
    if (isGenerated) files = [path.resolve('eval/references/generated-paisley.png')];
    const root = path.resolve(values.out ?? 'output/samples'); await mkdir(root, { recursive: true });
    const links: {name:string;relative:string}[] = [], failures: string[] = [];
    for (const file of files) {
      try {
        console.log(`Tracing ${path.basename(file)} ...`);
        let settings:z.infer<typeof sampleSettingsSchema>={};
        const settingsPath=path.join(path.dirname(file),`${path.parse(file).name}.jdm.json`);
        try{settings=sampleSettingsSchema.parse(await readJson(settingsPath));console.log(`  Using reviewed settings: ${path.basename(settingsPath)}`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        const sampleParams={...(settings.threshold!==undefined?{threshold:settings.threshold}:{}),...(settings.gapClosePx!==undefined?{gapClosePx:settings.gapClosePx}:{}),...params};
        const sampleRepeat=values.repeat!==undefined?repeat:{type:settings.repeat??repeat.type};
        const sampleWidths=widths??settings.widthsPx;
        const trial = await traceFile(file,sampleParams,message=>console.log(`  ${message}`),sampleRepeat), master = fillPlaceholders(trial.master,trial.faces);
        const name = `${slug(master.name)}-${hash(file).slice(0,6)}`, directory = path.join(root,name); await mkdir(directory,{recursive:true});
        await writeFile(path.join(directory,'source.png'),trial.sourceBytes);
        await writeJson(path.join(directory,'unassigned-master.json'),trial.master); await writeJson(path.join(directory,'master.json'),master);
        await writeJson(path.join(directory,'trace-report.json'),{...trial.report,traceMs:trial.traceMs});
        await writeFile(path.join(directory,'trace-overlay.svg'),masterSvg(master,trial.faces,trial.sourceBytes));
        await writeFile(path.join(directory,'master.svg'),masterSvg(master,trial.faces));
        const results = [];
        const prepared={geometry:master.geometry,faces:trial.faces,warnings:[] as string[]};
        if(sampleWidths)for(const widthPx of sampleWidths){console.log(`  Rendering ${widthPx} hooks ...`);results.push(await exportMaster(master,profile,{mode:'grid',widthPx,linkAspect:true},path.join(directory,`size-${widthPx}px.bmp`),rules,[],prepared));}
        else for (const width of [1.25,2.5,5]) results.push(await exportMaster(master,profile,{mode:'physical',unit:'in',width,linkAspect:true},path.join(directory,`size-${width}in.bmp`),rules,[],prepared));
        await writeReview(directory,master,trial.report,results,isGenerated,true);
        const largest=results.reduce((a,b)=>a.widthPx>b.widthPx?a:b);
        const editor=await writeStrokeEditor(directory,master,{profile,widthPx:largest.widthPx,heightPx:largest.heightPx,rules,previewPng:largest.png});
        links.push({name:master.name,relative:`${name}/review.html`});
        console.log(`  ${trial.report.nodes} nodes, ${trial.report.faces} faces, ${trial.report.openEnds.length} open ends; ${trial.traceMs.toFixed(0)} ms`);
        console.log(`  Review: ${path.join(directory,'review.html')}`);
        console.log(`  Stroke editor: ${editor}`);
      } catch (error) { const message = `${path.basename(file)}: ${(error as Error).message}`; failures.push(message); console.error(message); }
    }
    await writeFile(path.join(root,'index.html'),`<!doctype html><html><meta charset="utf-8"><title>JDM sample reviews</title><style>body{max-width:900px;margin:60px auto;padding:20px;font:18px/1.6 system-ui;background:#f3f0e9;color:#28342f}a{color:#275744}li{margin:12px 0}</style><h1>JDM sample reviews</h1><p>${isGenerated?'AI-generated development reference.':'Customer PNGs from '+escapeHtml(folder)+'.'} Test coloring and placeholder machine profiles require designer review.</p><ul>${links.map(l=>`<li><a href="${escapeHtml(l.relative)}">${escapeHtml(l.name)}</a></li>`).join('')}</ul>${failures.length?`<h2>Failed inputs</h2><ul>${failures.map(f=>`<li>${escapeHtml(f)}</li>`).join('')}</ul>`:''}</html>`);
    if (failures.length) process.exitCode = 1;
    console.log(`Sample index: ${path.join(root,'index.html')}`); return;
  }
  if (!input) throw new Error('Specify an input file. Use --help for examples.');
  if (values.out && path.resolve(values.out) === path.resolve(input)) throw new Error('Choose an output path different from the source');
  if (command === 'trace') {
    const out=jsonOutput(input,values.out,'master'),reportPath=out.replace(/\.json$/i,'.trace-report.json');
    assertOutputPaths([out,reportPath],protectedInputs);
    const result = await traceFile(input,params,undefined,repeat);
    await writeJson(out,result.master); await writeJson(reportPath,{...result.report,traceMs:result.traceMs});
    console.log(`Saved ${out}: ${result.report.faces} faces, ${result.report.openEnds.length} open ends`); return;
  }
  const master = validateMaster(await readJson(input));
  if(command==='inspect'){
    if(values['width-in']!==undefined||values['height-in']!==undefined||values['fit-across']!==undefined)throw new Error('Stroke inspection uses --width-px and optional --height-px');
    const directory=values.out??path.join('output','editor',slug(master.name));
    assertOutputPaths(['stroke-editor.html','stroke-editor.js'].map(name=>path.join(directory,name)),protectedInputs);
    const editor=await writeStrokeEditor(directory,master,{profile,widthPx:numeric('width-px')??Math.min(1200,profile.hooks),heightPx:numeric('height-px'),rules});
    console.log(`Stroke editor: ${editor}`);return;
  }
  if(command==='apply'){
    if(!values.ops)throw new Error('Specify an operation array with --ops edits.json');
    const operations=await readJson(values.ops);if(!Array.isArray(operations))throw new Error('Operations must be a JSON array');
    const out=jsonOutput(input,values.out,'edited');assertOutputPaths([out],protectedInputs);
    let edited=master;for(const op of operations){if(!op||typeof op.t!=='string')throw new Error('Invalid operation');const result=applyOperation(edited,op as Operation);edited=result.master;for(const warning of result.warnings)console.warn(`Warning: ${warning}`);}
    edited.version++;edited.updatedAt=new Date().toISOString();await writeJson(out,edited);console.log(`Saved ${operations.length} edits to ${out}`);return;
  }
  if (command === 'fill') {
    if (!values['auto-placeholders']) throw new Error('Use --auto-placeholders for test colors. Real yarn colors are a designer decision.');
    const out = jsonOutput(input,values.out,'filled');assertOutputPaths([out],protectedInputs); await writeJson(out,fillPlaceholders(master)); console.log(`Saved test colors to ${out}`); return;
  }
  if (command === 'render') {
    let size: SizeInput;
    if (values['fit-across'] !== undefined) size = { mode:'fitAcross',n:numeric('fit-across')! };
    else if (values['width-px'] !== undefined || values['height-px'] !== undefined) size = { mode:'grid',widthPx:numeric('width-px'),heightPx:numeric('height-px'),linkAspect:true };
    else size = { mode:'physical',unit:'in',width:numeric('width-in'),height:numeric('height-in'),linkAspect:true };
    const overrides = values.overrides ? await readJson(values.overrides) : [];
    if (!Array.isArray(overrides) || overrides.some(p=>!p || !Number.isInteger(p.x) || !Number.isInteger(p.y) || !Number.isInteger(p.colorIndex) || p.colorIndex<0 || p.colorIndex>=master.palette.entries.length)) throw new Error('Overrides must be an array of integer x/y/colorIndex entries from the palette');
    const out=values.out??'output/export.bmp';assertOutputPaths(exportPaths(out),protectedInputs);
    const result = await exportMaster(master,profile,size,out,rules,overrides);
    console.log(`Exported ${result.widthPx} × ${result.heightPx}: ${result.stem}.bmp`); for (const warning of result.report.warnings) console.warn(`Warning: ${warning}`); return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error=>{console.error(`JDM: ${(error as Error).message}`);process.exitCode=1;});
