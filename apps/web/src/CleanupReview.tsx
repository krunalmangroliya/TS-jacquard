import {useEffect,useRef,useState} from 'react';
import type {DesignRecord} from '../../../packages/app-model/src/index';
import type {MachineProfile,RuleConfig,Palette} from '../../../packages/core/src/types';
import type {EditorState} from './editor-protocol';
import type {CleanupPreviewResult,CleanupPreviewReply} from './cleanup-preview.worker';
import {cleanupPreviewIsCurrent,MAX_CLEANUP_REVIEW_AREAS} from './cleanup-preview';
import {cleanupDetailCrop,type SourceDetailPreview} from './cleanup-source-preview';
import './cleanup-review.css';

export interface CleanupReviewSource {document:DesignRecord;profile:MachineProfile;before:EditorState['render'];sequence:number;rules:RuleConfig;title:string}
function PixelView({grid,width,height,palette,location,whole,overlay,before}:{grid:Uint8Array;width:number;height:number;palette:Palette;location:number;whole:boolean;overlay:boolean;before?:Uint8Array}){
  const canvas=useRef<HTMLCanvasElement>(null);
  const crop=whole?{x:0,y:0,w:width,h:height}:cleanupDetailCrop(width,height,location),{x:left,y:top,w,h}=crop;
  useEffect(()=>{
    const element=canvas.current!;element.width=w;element.height=h;const rgba=new Uint8ClampedArray(w*h*4);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const p=(top+y)*width+left+x,color=palette.entries[grid[p]].exportRgb,i=(y*w+x)*4,marked=overlay&&before&&before[p]!==grid[p];
      rgba[i]=marked?255:color[0];rgba[i+1]=marked?40:color[1];rgba[i+2]=marked?180:color[2];rgba[i+3]=255;
    }
    element.getContext('2d')!.putImageData(new ImageData(rgba,w,h),0,0);
  },[grid,width,palette,overlay,before,w,h,left,top]);
  return <><canvas ref={canvas} aria-label={before?'Proposed cleanup pixels':'Current pixels'} style={{aspectRatio:`${w}/${h}`}}/>{!whole&&<p className="muted">Pixels {left}, {top} · {w} × {h} crop</p>}</>;
}

function SourcePixelView({detail,palette}:{detail:SourceDetailPreview;palette:Palette}){
  const canvas=useRef<HTMLCanvasElement>(null),{sourceCrop:crop,sourceWindow:window,originalFileCrop:original,outputCrop}=detail;
  useEffect(()=>{
    const element=canvas.current!;element.width=detail.width;element.height=detail.height;const rgba=new Uint8ClampedArray(detail.pixels.length*4);
    for(let i=0;i<detail.pixels.length;i++){const color=palette.entries[detail.pixels[i]].exportRgb,p=i*4;rgba[p]=color[0];rgba[p+1]=color[1];rgba[p+2]=color[2];rgba[p+3]=255;}
    element.getContext('2d')!.putImageData(new ImageData(rgba,detail.width,detail.height),0,0);
  },[detail,palette]);
  return <><div className="cleanup-source-frame" style={{aspectRatio:`${outputCrop.w}/${outputCrop.h}`,maxWidth:`calc(55vh * ${outputCrop.w/outputCrop.h})`}}><canvas ref={canvas} aria-label="Imported source detail pixels" style={{left:`${(crop.x-window.x)/window.w*100}%`,top:`${(crop.y-window.y)/window.h*100}%`,width:`${crop.w/window.w*100}%`,height:`${crop.h/window.h*100}%`}}/></div><p className="muted">Source pixels {original.x}, {original.y} · {original.w} × {original.h} crop</p>{detail.sampled&&<p className="cleanup-source-note" role="status">Large source area: this preview is sampled to {detail.width} × {detail.height} pixels. Some fine source detail may be hidden.</p>}</>;
}

export default function CleanupReview({source,currentSequence,pending,onApply,onClose}:{source:CleanupReviewSource;currentSequence:number;pending:boolean;onApply:(rules:RuleConfig)=>void;onClose:()=>void}){
  const [result,setResult]=useState<CleanupPreviewResult>(),[error,setError]=useState(''),[whole,setWhole]=useState(false),[index,setIndex]=useState(0),[overlay,setOverlay]=useState(false);
  const [showSource,setShowSource]=useState(false),[sourceDetail,setSourceDetail]=useState<SourceDetailPreview>(),[sourceError,setSourceError]=useState(''),[sourcePending,setSourcePending]=useState(false),[manualLocation,setManualLocation]=useState<number>(),[jumpX,setJumpX]=useState('0'),[jumpY,setJumpY]=useState('0');
  const reviewWorker=useRef<Worker|null>(null),sourceRequest=useRef(0);
  useEffect(()=>{
    let live=true;setResult(undefined);setError('');setSourceDetail(undefined);setSourceError('');setSourcePending(false);setManualLocation(undefined);setIndex(0);sourceRequest.current++;
    const worker=new Worker(new URL('./cleanup-preview.worker.ts',import.meta.url),{type:'module'});reviewWorker.current=worker;
    worker.onmessage=({data}:{data:CleanupPreviewReply})=>{
      if(!live)return;
      if(data.type==='source-detail'){if(data.requestId===sourceRequest.current){setSourceDetail(data.detail);setSourcePending(false);}return;}
      if(data.type==='error'){
        if(data.scope==='source-detail'){if(data.requestId===sourceRequest.current){setSourceError(data.error);setSourcePending(false);}}
        else{setError(data.error);worker.terminate();reviewWorker.current=null;}
      }else setResult(data);
    };
    worker.onerror=event=>{if(!live)return;setError(event.message||'Cleanup preview stopped.');worker.terminate();if(reviewWorker.current===worker)reviewWorker.current=null;};
    worker.postMessage({type:'preview',document:source.document,profile:source.profile,rules:source.rules,before:{grid:source.before.grid,widthPx:source.before.widthPx,heightPx:source.before.heightPx}});
    return()=>{live=false;sourceRequest.current++;worker.terminate();if(reviewWorker.current===worker)reviewWorker.current=null;};
  },[source]);
  const fresh=cleanupPreviewIsCurrent(source.sequence,currentSequence,pending),locations=result?.difference.locations??[],location=manualLocation??locations[index%Math.max(1,locations.length)]??0;
  const repairColors=source.rules.repairColorIndices??(source.rules.outlineColorIndex===undefined?[]:[source.rules.outlineColorIndex]);
  const jumpValid=jumpX.trim()!==''&&jumpY.trim()!==''&&[Number(jumpX),Number(jumpY)].every(Number.isSafeInteger)&&Number(jumpX)>=0&&Number(jumpX)<source.before.widthPx&&Number(jumpY)>=0&&Number(jumpY)<source.before.heightPx;
  useEffect(()=>{
    const requestId=++sourceRequest.current;setSourceDetail(undefined);setSourceError('');
    if(!showSource||whole||!result||!reviewWorker.current){setSourcePending(false);return;}
    setSourcePending(true);
    const worker=reviewWorker.current,timer=setTimeout(()=>worker.postMessage({type:'source-detail',requestId,location}),75);
    return()=>{clearTimeout(timer);sourceRequest.current++;};
  },[showSource,whole,location,result,source]);
  return <div className="cleanup-review"><header><div><h2>{source.title}</h2><p>Review the proposed pixels before applying this cleanup.</p></div><button onClick={onClose}>{result?'Keep current':'Cancel preview'}</button></header>
    {!fresh&&<p role="status" className="cleanup-review-warning">The design changed. Close this preview and prepare it again before applying.</p>}
    {error?<p role="alert">{error}</p>:!result?<p role="status">Preparing cleanup comparison…</p>:<>
      <div className="cleanup-review-summary"><strong>{result.difference.changedPixels.toLocaleString()} pixels differ from the current size</strong><p>Changes can include restored detail as well as removed pixels. Review small dots and narrow gaps.</p></div>
      <details><summary>Proposed cleanup settings</summary><p>Minimum region: {source.rules.minRegionPx} pixels · Remove thin details: {source.rules.minThicknessPx} pixels · Checkerboards: {source.rules.removeCheckerboard?'on':'off'} · Sampling: {source.rules.rasterResize==='preserve-outline'?'preserve outline':'original'} · Outline gap repair: {source.rules.repairOutlineGaps?'on':'off'}</p>{source.rules.repairOutlineGaps&&<p>Repair colors: {repairColors.length?repairColors.map(color=>`${color} · ${source.document.master.palette.entries[color]?.name??'Color'}`).join(', '):'none selected'}</p>}</details>
      {result.render.report.warnings.length>0&&<div className="cleanup-review-warning" role="status"><strong>Processing notes</strong><ul>{result.render.report.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul></div>}
      <div className="cleanup-review-toolbar"><label><input type="checkbox" checked={whole} onChange={e=>setWhole(e.target.checked)}/>Whole design</label><label><input type="checkbox" checked={overlay} onChange={e=>setOverlay(e.target.checked)}/>Highlight changed pixels</label><label><input type="checkbox" checked={showSource&&!whole} onChange={e=>{setShowSource(e.target.checked);if(e.target.checked)setWhole(false);}}/>Show source detail</label>{!whole&&locations.length>0&&<><button disabled={index===0&&manualLocation===undefined} onClick={()=>{setManualLocation(undefined);setIndex(i=>Math.max(0,i-1));}}>Previous area</button><span>{manualLocation===undefined?`Area ${index+1} / ${locations.length}${locations.length===MAX_CLEANUP_REVIEW_AREAS?' (first 4,096; use coordinates for more)':''}`:'Custom area'}</span><button disabled={index+1>=locations.length&&manualLocation===undefined} onClick={()=>{setManualLocation(undefined);setIndex(i=>Math.min(locations.length-1,i+1));}}>Next area</button></>}</div>
      <div className="cleanup-review-jump"><span>Go to output pixel</span><label>X<input aria-label="Output pixel X" type="number" min="0" max={source.before.widthPx-1} step="1" value={jumpX} onChange={e=>setJumpX(e.target.value)}/></label><label>Y<input aria-label="Output pixel Y" type="number" min="0" max={source.before.heightPx-1} step="1" value={jumpY} onChange={e=>setJumpY(e.target.value)}/></label><button disabled={!jumpValid} onClick={()=>{setManualLocation(Number(jumpY)*source.before.widthPx+Number(jumpX));setWhole(false);}}>Show area</button>{manualLocation!==undefined&&locations.length>0&&<button onClick={()=>setManualLocation(undefined)}>Back to changed areas</button>}</div>
      {showSource&&!whole&&<p className="muted">The imported source is shown before resizing and cleanup, using this review’s palette. All three panes show the same output area; source pixels may appear rectangular. Coordinates refer to the original uploaded image.</p>}
      <div className={`cleanup-review-pair${showSource&&!whole?' has-source':''}`}>{showSource&&!whole&&<article><h3>Imported source</h3>{sourcePending?<p role="status">Loading source detail…</p>:sourceError?<p role="alert">{sourceError}</p>:sourceDetail?<SourcePixelView detail={sourceDetail} palette={source.document.master.palette}/>:null}</article>}<article><h3>Current size</h3><PixelView grid={source.before.grid} width={source.before.widthPx} height={source.before.heightPx} palette={source.document.master.palette} location={location} whole={whole} overlay={false}/></article><article><h3>Proposed cleanup</h3><PixelView grid={result.render.grid} before={source.before.grid} width={result.render.widthPx} height={result.render.heightPx} palette={source.document.master.palette} location={location} whole={whole} overlay={overlay}/></article></div>
      <details><summary>Color area changes</summary><ul>{result.difference.colorDeltas.flatMap((delta,i)=>delta?[<li key={i}>{i} · {source.document.master.palette.entries[i].name}: {delta>0?'+':''}{delta.toLocaleString()} pixels</li>]:[])}</ul></details>
      <footer><p>The chosen area, colors, protected colors and Pixel pencil corrections are retained. Applying is one undoable change.</p><button className="primary" disabled={!fresh||pending||!result.difference.changedPixels} onClick={()=>onApply(source.rules)}>Apply proposed cleanup</button></footer>
    </>}
  </div>;
}
