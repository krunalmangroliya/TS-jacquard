import {useEffect,useRef,useState} from 'react';
import type {DesignRecord,WorkspaceSettings} from '../../../packages/app-model/src/index';
import type {EditorRender,EditorState} from './editor-protocol';
import {displayPixelAspect} from './source-aspect';

function DesignImage({render,document}:{render:EditorRender;document:DesignRecord}){
  const ref=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const canvas=ref.current!;canvas.width=render.widthPx;canvas.height=render.heightPx;
    const rgba=new Uint8ClampedArray(render.grid.length*4);
    for(let i=0;i<render.grid.length;i++){
      const color=document.master.palette.entries[render.grid[i]][document.kind==='size'?'exportRgb':'displayRgb'];
      rgba[i*4]=color[0];rgba[i*4+1]=color[1];rgba[i*4+2]=color[2];rgba[i*4+3]=255;
    }
    canvas.getContext('2d')!.putImageData(new ImageData(rgba,canvas.width,canvas.height),0,0);
  },[render,document.master.palette,document.kind]);
  const rasterMaster=document.kind==='master'&&!!document.master.raster,density=rasterMaster?document.master.source.interpretation?.density:undefined;
  const ratio=document.master.raster?render.widthPx/(render.heightPx*(rasterMaster?displayPixelAspect(document.master,document.kind,render,true):1)):render.widthIn/render.heightIn;
  const dimensions=rasterMaster?density?`${(document.master.raster!.width/density.epi).toFixed(2)} × ${(document.master.raster!.height/density.ppi).toFixed(2)} in at source density`:'Source pixel preview':`${render.widthIn.toFixed(2)} × ${render.heightIn.toFixed(2)} in`;
  return <><div className="comparison-artboard" style={{aspectRatio:String(ratio),width:'100%',maxWidth:`calc(62vh * ${ratio})`,margin:'0 auto'}}><canvas ref={ref} style={{display:'block',width:'100%',height:'100%',maxHeight:'none',objectFit:'fill',imageRendering:'pixelated'}}/></div><p className="muted">{render.widthPx} × {render.heightPx} {rasterMaster?'preview pixels':'pixels'} · {dimensions}</p></>;
}

export default function Compare({previous,current,settings,previousLabel='Selected version'}:{previous:DesignRecord;current:EditorState;settings:WorkspaceSettings;previousLabel?:string}){
  const [state,setState]=useState<EditorState>(),[error,setError]=useState('');
  useEffect(()=>{
    setState(undefined);setError('');
    const worker=new Worker(new URL('./editor.worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=({data})=>{if(data.type==='ready')setState(data);if(data.type==='error')setError(data.message);};
    worker.onerror=e=>setError(e.message);
    worker.postMessage({type:'init',requestId:1,document:previous,profile:settings.profiles.find(p=>p.id===previous.profileId)??settings.profiles[0],previewWidth:1000});
    return()=>worker.terminate();
  },[previous]);
  return <div className="compare-grid"><article><h2>{previousLabel}</h2>{state?<DesignImage render={state.render} document={previous}/>:<p>{error||'Preparing comparison…'}</p>}</article><article><h2>Current draft</h2><DesignImage render={current.render} document={current.document}/></article></div>;
}
