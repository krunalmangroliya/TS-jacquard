import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import DesignCanvas,{type Selection,type Tool} from '../../apps/web/src/DesignCanvas';
import {applyOperation} from '../../packages/core/src/ops';
import type {DesignRecord,EditorAction} from '../../packages/app-model/src';
import {useEditor} from '../../apps/web/src/useEditor';
import {checkPreviewEdits} from './canvas-preview-regressions';
import '../../apps/web/src/style.css';
const fixture=await(await fetch('/canvas-fixture')).json();
fixture.render.grid=Uint8Array.from(atob(fixture.grid),c=>c.charCodeAt(0));fixture.render.changedPixelsMask=new Uint8Array(fixture.render.grid.length);
const state=window as unknown as {fixture:typeof fixture;actions:EditorAction[];__JDM_CANVAS_METRICS__:number[];ready:boolean;choose:(nodeId:string)=>void;tool:(name:Tool)=>void;save?:()=>Promise<DesignRecord|undefined>;editorDocument?:DesignRecord;error?:string;renderPending?:boolean;commitDelay?:number};state.fixture=fixture;state.actions=[];state.__JDM_CANVAS_METRICS__=[];
(window as any).runPreviewChecks=checkPreviewEdits;
function App(){const[doc,setDoc]=useState<DesignRecord>(fixture.document),[selection,setSelection]=useState<Selection>(fixture.selection),[tool,setTool]=useState<Tool>('node'),[command,setCommand]=useState<{kind:'focus';serial:number;point:{x:number;y:number}}>({kind:'focus',serial:1,point:fixture.point});
  state.choose=(nodeId:string)=>{const edge=Object.values(doc.master.geometry.edges).find(edge=>edge.nodeIds.includes(nodeId))!,owner=doc.master.objects.find(object=>object.edgeIds.includes(edge.id));setSelection({edgeId:edge.id,nodeId,objectIds:owner?[owner.id]:[]});setCommand({kind:'focus',serial:Math.random(),point:doc.master.geometry.nodes[nodeId].p});};state.tool=setTool;
  function action(action:EditorAction){state.actions.push(action);setTimeout(()=>{if(action.type==='operation')setDoc(previous=>({...previous,master:applyOperation(previous.master,action.operation,{assumeValidated:true,deferTopology:true}).master}));},state.commitDelay??400);}
  useEffect(()=>{state.ready=true;},[]);
  return <div style={{width:'1400px',height:'900px',display:'flex'}}><DesignCanvas document={doc} renderedDocument={fixture.document} renderPending={doc!==fixture.document} geometry={fixture.geometry} render={fixture.render} tool={tool} color={2} selection={selection} onSelect={setSelection} onAction={action} onFill={()=>{}} options={{boundaries:true,nodes:true,repeat:false,trueProportion:true,grid:false,changes:false,overrides:false,hidden:false}} viewCommand={command} disabled={false} onZoom={()=>{}}/></div>;
}
function Integrated(){const hook=useEditor(fixture.document,fixture.settings),[selection,setSelection]=useState<Selection>(fixture.selection),[command,setCommand]=useState<{kind:'focus';serial:number;point:{x:number;y:number}}>({kind:'focus',serial:1,point:fixture.point}),doc=hook.interactiveDocument??hook.state?.document??fixture.document;state.editorDocument=doc;state.error=hook.error;state.renderPending=hook.renderPending;state.save=hook.save;
  state.choose=(nodeId:string)=>{const edge=Object.values(doc.master.geometry.edges).find(edge=>edge.nodeIds.includes(nodeId))!,owner=doc.master.objects.find(object=>object.edgeIds.includes(edge.id));setSelection({edgeId:edge.id,nodeId,objectIds:owner?[owner.id]:[]});setCommand({kind:'focus',serial:Math.random(),point:doc.master.geometry.nodes[nodeId].p});};
  useEffect(()=>{state.ready=!!hook.state&&!!hook.geometry&&!hook.busy;},[hook.state,hook.geometry,hook.busy]);
  if(!hook.state||!hook.geometry)return <p>Loading actual editor worker…</p>;
  return <div style={{width:'1400px',height:'900px',display:'flex'}}><DesignCanvas document={doc} renderedDocument={hook.renderedDocument} renderPending={hook.renderPending} geometry={hook.geometry} render={hook.state.render} tool="node" color={2} selection={selection} onSelect={setSelection} onAction={action=>{state.actions.push(action);void hook.action(action);}} onFill={()=>{}} options={{boundaries:true,nodes:true,repeat:false,trueProportion:true,grid:false,changes:false,overrides:false,hidden:false}} viewCommand={command} disabled={hook.busy||hook.readOnly} onZoom={()=>{}}/></div>;
}
createRoot(document.getElementById('root')!).render(fixture.integrated?<Integrated/>:<App/>);

