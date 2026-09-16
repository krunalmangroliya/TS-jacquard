import {useEffect,useState} from 'react';
import type {DesignRecord,WorkspaceSettings} from '../../../packages/app-model/src/index';
import {api} from './api';
import Library from './Library';
import Import from './Import';
import Settings from './Settings';
import Editor from './Editor';
export default function App(){
  const [route,setRoute]=useState(location.hash.slice(1)||'/'),[settings,setSettings]=useState<WorkspaceSettings>(),[document,setDocument]=useState<DesignRecord>(),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const go=(path:string)=>{location.hash=path;};
  useEffect(()=>{const change=()=>setRoute(location.hash.slice(1)||'/');window.addEventListener('hashchange',change);void api<WorkspaceSettings>('/workspace').then(setSettings).catch(e=>setError(e.message));return()=>window.removeEventListener('hashchange',change);},[]);
  useEffect(()=>{let cancelled=false;setError('');setDocument(undefined);if(route.startsWith('/design/')){setLoading(true);void api<DesignRecord>(`/designs/${encodeURIComponent(route.slice(8))}`).then(record=>{if(!cancelled)setDocument(record);}).catch(e=>!cancelled&&setError(e.message)).finally(()=>!cancelled&&setLoading(false));}else setLoading(false);return()=>{cancelled=true;};},[route]);
  const open=(id:string)=>go('/design/'+id);
  if(!settings)return <div className="app-loading"><div className="brand-mark">J</div><h1>Opening your studio</h1><p>{error||'Connecting to local storage…'}</p>{error&&<button onClick={()=>location.reload()}>Try again</button>}</div>;
  if(document)return <Editor key={`${document.id}-${document.revision}`} initial={document} settings={settings} onBack={()=>go('/')} onOpen={open} onReload={async()=>{const updated=await api<DesignRecord>(`/designs/${document.id}`);setDocument(updated);}}/>;
  return <div className="studio-shell"><header className="studio-header"><button className="wordmark" onClick={()=>go('/')}><span className="brand-mark">J</span><span>JDM <small>DESIGN STUDIO</small></span></button><nav><button className={route==='/'?'active':''} onClick={()=>go('/')}>Design library</button><button className={route==='/settings'?'active':''} onClick={()=>go('/settings')}>Settings</button></nav><span className="local-pill"><i/>Local workspace</span></header>{error?<main className="page-error"><h1>Could not open this design</h1><p>{error}</p><button onClick={()=>go('/')}>Back to library</button></main>:loading?<div className="app-loading compact">Opening design…</div>:(route==='/import'||route==='/import/image')?<Import key={route} initialMode={route==='/import/image'?'image':'sketch'} settings={settings} onCreated={open} onCancel={()=>go('/')}/>:route==='/settings'?<Settings settings={settings} onSaved={next=>{setSettings(next);go('/');}} onCancel={()=>go('/')}/>:<Library onOpen={open} onImport={()=>go('/import')} onImageImport={()=>go('/import/image')} onSettings={()=>go('/settings')} refreshKey={route}/>}<footer className="studio-footer"><span>JDM · One master, every loom size.</span><span>Designs saved on this PC</span></footer></div>;
}
