import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesignRecord, DesignSummary } from '../../../packages/app-model/src';
import { clientId, Icon, Notice, request, ScreenHeader, Spinner, Thumbnail } from './ui';
import './library.css';

interface Props { onOpen: (id: string) => void; onImport: () => void; onSettings: () => void; refreshKey?: unknown }

export default function Library({ onOpen, onImport, onSettings, refreshKey }: Props) {
  const [designs, setDesigns] = useState<DesignSummary[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [sort, setSort] = useState('recent'), [reload, setReload] = useState(0), [busyId, setBusyId] = useState('');
  const [archiveId, setArchiveId] = useState<string | null>(null), [notice, setNotice] = useState('');
  const jsonInput = useRef<HTMLInputElement>(null);
  const [showArchived,setShowArchived] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    request<DesignSummary[]>(showArchived?'/api/archived':'/api/designs', { signal: controller.signal }).then(setDesigns).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refreshKey, reload, showArchived]);
  const masters = designs.filter(design => design.kind === 'master'), sizes = designs.filter(design => design.kind === 'size');
  const displayed = useMemo(() => {
    const search = query.trim().toLowerCase(), parents = new Set(designs.filter(item => item.kind === 'master').map(item => item.id));
    const matches = (design: DesignSummary) => `${design.name} ${design.tags.join(' ')}`.toLowerCase().includes(search);
    return designs.filter(design => (showArchived || design.kind === 'master' || !design.masterId || !parents.has(design.masterId)) && (matches(design) || designs.some(size => size.masterId === design.id && matches(size))))
      .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [designs, query, sort, showArchived]);
  async function duplicate(design: DesignSummary) {
    setBusyId(design.id); setError('');
    try { const result = await request<DesignRecord>(`/api/designs/${encodeURIComponent(design.id)}/duplicate`, { method: 'POST', body: JSON.stringify({}) }); setNotice(`“${result.name}” is ready in your library.`); setReload(value => value + 1); }
    catch (error) { setError((error as Error).message); } finally { setBusyId(''); }
  }
  async function archive(design: DesignSummary) {
    setBusyId(design.id); setError('');
    const id = clientId(), url = `/api/designs/${encodeURIComponent(design.id)}`;
    let acquired = false, archived = false;
    try {
      const lock = await request<{ acquired: boolean }>(`${url}/lock`, { method: 'POST', body: JSON.stringify({ clientId: id }) });
      if (!lock.acquired) throw new Error('This design is open in another window. Close it there before archiving.');
      acquired = true;
      await request(url, { method: 'DELETE', body: JSON.stringify({ expectedRevision: design.revision, clientId: id }) });
      archived = true;
      setArchiveId(null); setNotice(`“${design.name}” was archived.`); setReload(value => value + 1);
    } catch (error) { setError((error as Error).message); }
    finally { if (acquired && !archived) await request(`${url}/lock`, { method: 'DELETE', body: JSON.stringify({ clientId: id }) }).catch(() => undefined); setBusyId(''); }
  }
  async function restoreArchived(design:DesignSummary){
    setBusyId(design.id);setError('');
    try{await request('/api/designs/'+design.id+'/unarchive',{method:'POST',body:JSON.stringify({expectedRevision:design.revision,clientId:clientId()})});setNotice('“'+design.name+'” is back in your library.');setReload(value=>value+1);}catch(error){setError((error as Error).message);}finally{setBusyId('');}
  }
  async function openJson(file?: File) {
    if (!file) return; setBusyId('json'); setError('');
    try {
      const parsed = JSON.parse(await file.text()), master = parsed?.document?.master?.schemaVersion ? parsed.document.master : parsed?.master?.schemaVersion ? parsed.master : parsed;
      if(parsed?.pending?.length)throw new Error('This recovery file contains unapplied edits. Reopen the original design to recover them before importing it.');
      if (!master || typeof master !== 'object' || Array.isArray(master)) throw new Error('Choose a saved JDM master JSON file. This file does not contain a master.');
      const record = await request<DesignRecord>('/api/designs', { method: 'POST', body: JSON.stringify({ master, name: master.name }) }); onOpen(record.id);
    } catch (error) { setError(error instanceof SyntaxError ? 'This file is not valid JSON. Choose a saved JDM master JSON file.' : (error as Error).message); }
    finally { setBusyId(''); if (jsonInput.current) jsonInput.current.value = ''; }
  }
  return <main className="jdm-library jdm-screen">
    <ScreenHeader eyebrow="JACQUARD DESIGN MASTER" title={showArchived?"Archived designs":"Your design library"} description={showArchived?"Restore a design whenever you need it again.":"Keep the original. Make every size from one master."}>
      <button className="jdm-button jdm-button-quiet" onClick={onSettings}><Icon name="settings" /> Workspace settings</button>
      <button className="jdm-button jdm-button-primary" onClick={onImport}><Icon name="plus" /> New master</button>
    </ScreenHeader>
    {error && <Notice tone="error" onClose={() => setError('')}>{error} {loading || designs.length ? null : <button className="jdm-link-button" onClick={() => setReload(value => value + 1)}>Try again</button>}</Notice>}
    {notice && <Notice tone="success" onClose={() => setNotice('')}>{notice}</Notice>}
    <section className="jdm-library-tools" aria-label="Find a design"><label className="jdm-search"><Icon name="search" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search designs or tags" aria-label="Search designs or tags" />{query && <button className="jdm-icon-button" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" size={16} /></button>}</label><div className="jdm-library-tools-right"><button className="jdm-button jdm-button-quiet" disabled={!!busyId} onClick={()=>{setShowArchived(value=>!value);setQuery('');setArchiveId(null);}}>{showArchived?'Back to library':'Archived'}</button><span className="jdm-muted">{masters.length} masters · {sizes.length} sizes</span><select className="jdm-select" aria-label="Sort designs" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Recently edited</option><option value="name">Name A–Z</option></select><button className="jdm-button jdm-button-quiet" disabled={busyId === 'json'} onClick={() => jsonInput.current?.click()}>{busyId === 'json' ? <Spinner /> : <Icon name="upload" size={17} />} Open JSON</button><input type="file" accept=".json,application/json" hidden ref={jsonInput} onChange={event => void openJson(event.target.files?.[0])} /></div></section>
    {loading ? <div className="jdm-empty"><Spinner label="Opening your library…" /></div> : !designs.length && !error && showArchived ? <section className="jdm-empty"><h2>No archived designs</h2><p>Archived masters and sizes will appear here.</p><button className="jdm-button" onClick={()=>setShowArchived(false)}>Back to library</button></section> : !designs.length && !error ? <section className="jdm-empty jdm-first-design"><div className="jdm-empty-art"><Icon name="leaf" size={72} /></div><div className="jdm-eyebrow">A place for your next design</div><h2>Start with a clean line drawing.</h2><p>Import a PNG, review the traced lines, then fill your master with up to six colors.</p><button className="jdm-button jdm-button-primary" onClick={onImport}><Icon name="plus" /> Create your first master</button><span className="jdm-fine">Saved locally on this computer</span></section> : !displayed.length && !error ? <div className="jdm-empty"><Icon name="search" size={32} /><h2>No designs match “{query}”.</h2><p>Try another name or tag.</p><button className="jdm-button" onClick={() => setQuery('')}>Clear search</button></div> : <section className="jdm-design-grid" aria-label="Designs">
      {displayed.map(design => { if(showArchived)return <article className="jdm-design-card archived-card" key={design.id}><Thumbnail id={design.id} name={design.name}/><div><h2>{design.name}</h2><p className="jdm-fine">{design.kind==='master'?'Master':'Size variant'} · Version {design.version}</p><button className="jdm-button jdm-button-primary" disabled={!!busyId} onClick={()=>void restoreArchived(design)}>{busyId===design.id?'Restoring…':'Restore to library'}</button></div></article>; const variants = sizes.filter(size => size.masterId === design.id), archiveTarget = archiveId === design.id ? design : variants.find(size => size.id === archiveId); return <article className="jdm-design-card" key={design.id}>
        <button className="jdm-card-open" onClick={() => onOpen(design.id)}><Thumbnail id={design.id} name={design.name} /><div className="jdm-card-heading"><div><h2>{design.name}</h2><span className="jdm-fine">{design.kind === 'size' ? 'Size variant' : 'Master'} · Version {design.version}</span></div><span className="jdm-open-arrow" aria-hidden="true">↗</span></div></button>
        <div className="jdm-card-meta">{design.tags.length ? <div className="jdm-tags">{design.tags.slice(0, 4).map((tag, index) => <button key={`${tag}-${index}`} className="jdm-tag" onClick={() => setQuery(tag)}>{tag}</button>)}</div> : <span className="jdm-fine">Ready for your next size</span>}<div className="jdm-card-actions"><button className="jdm-icon-button" title={`Duplicate ${design.name}`} aria-label={`Duplicate ${design.name}`} disabled={!!busyId} onClick={() => void duplicate(design)}><Icon name="copy" size={17} /></button><button className="jdm-icon-button" title={`Archive ${design.name}`} aria-label={`Archive ${design.name}`} disabled={!!busyId} onClick={() => setArchiveId(archiveId === design.id ? null : design.id)}><Icon name="archive" size={17} /></button></div></div>
        {variants.length > 0 && <div className="jdm-variants"><span className="jdm-fine">Saved sizes</span><div>{variants.map(size => <div className="jdm-size-entry" key={size.id}><button className="jdm-size-chip" onClick={() => onOpen(size.id)}>{size.name}<span aria-hidden="true">↗</span></button><button className="jdm-icon-button" aria-label={`Duplicate ${size.name}`} title={`Duplicate ${size.name}`} disabled={!!busyId} onClick={() => void duplicate(size)}>{busyId === size.id && archiveId !== size.id ? <Spinner /> : <Icon name="copy" size={14} />}</button><button className="jdm-icon-button" aria-label={`Archive ${size.name}`} title={`Archive ${size.name}`} disabled={!!busyId} onClick={() => setArchiveId(archiveId === size.id ? null : size.id)}><Icon name="archive" size={14} /></button></div>)}</div></div>}
        {archiveTarget && <div className="jdm-inline-confirm"><span>Archive {archiveTarget.kind === 'master' ? 'this master' : `“${archiveTarget.name}”`}?</span><div><button className="jdm-button jdm-button-small" disabled={!!busyId} onClick={() => setArchiveId(null)}>Keep</button><button className="jdm-button jdm-button-small jdm-button-danger" disabled={!!busyId} onClick={() => void archive(archiveTarget)}>{busyId === archiveTarget.id ? <Spinner /> : 'Archive'}</button></div></div>}
        {busyId === design.id && archiveId !== design.id && <div className="jdm-card-progress"><Spinner label="Making a copy…" /></div>}
      </article>; })}
    </section>}
    <footer className="jdm-library-footer"><span className="jdm-local-dot" /> Local workspace <span>Masters stay editable. Size exports keep their own settings.</span></footer>
  </main>;
}
