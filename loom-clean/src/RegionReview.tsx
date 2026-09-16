import type { RegionScanResult, RegionView } from './region-types';
import type { Progress } from './types';

interface Props {
  progress: Progress | null;
  result: RegionScanResult | null;
  selectedIds: number[];
  view: RegionView;
  error: string;
  disabled: boolean;
  settingsChanged: boolean;
  onRun: () => void;
  onCancel: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onView: (view: RegionView) => void;
  onToggle: (id: number) => void;
  onFocus: (id: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}

export default function RegionReview({ progress, result, selectedIds, view, error, disabled, settingsChanged, onRun, onCancel, onApply, onDiscard, onView, onToggle, onFocus, onSelectAll, onSelectNone }: Props) {
  const selected = new Set(selectedIds);
  const included = result?.proposals.filter(proposal => selected.has(proposal.id)) || [];
  const changedPixels = included.reduce((sum, proposal) => sum + proposal.removedPixels, 0);
  return <section className="region-review" aria-labelledby="region-review-title" aria-busy={progress !== null}>
    <div className="region-review-heading"><span className="region-mark" aria-hidden="true">▧</span><div><span className="eyebrow">REVIEW WHOLE AREAS</span><h3 id="region-review-title">Noisy regions</h3></div></div>
    {!progress && !result && <>
      <p>Find areas of dense grain and preview a flat fill inside each area.</p>
      <button className="region-primary-button" disabled={disabled || settingsChanged} onClick={onRun}>Find noisy regions <span aria-hidden="true">↗</span></button>
      <p className="region-note">{settingsChanged ? 'Reprocess your changed recipe before finding regions.' : 'Review each suggested area, then apply only the ones you choose.'}</p>
    </>}
    {progress && <div className="region-running" role="status">
      <p>{progress.stage}</p>
      <div className="progress-track" role="progressbar" aria-label="Region scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percent)}><i style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div>
      <p className="region-note">Your canvas stays unchanged while the scan runs.</p>
      <button className="region-secondary-button" onClick={onCancel}>Cancel region scan</button>
    </div>}
    {error && <p className="region-error" role="alert">{error}</p>}
    {result && <>
      <p className="region-preview-status" role="status">{result.proposals.length ? `${result.proposals.length.toLocaleString()} suggested ${result.proposals.length === 1 ? 'region' : 'regions'} · not applied` : 'No dense grain regions found'}</p>
      {result.proposals.length > 0 ? <>
        <div className="region-selection-summary"><strong>{included.length} selected</strong><span>{changedPixels.toLocaleString()} pixel changes</span></div>
        <div className="region-view-buttons" role="group" aria-label="Region comparison view">{(['before', 'proposal', 'changes'] as const).map(value => <button key={value} disabled={disabled} className={view === value ? 'active' : ''} aria-pressed={view === value} onClick={() => onView(value)}>{value === 'before' ? 'Before' : value === 'proposal' ? 'Proposed' : 'Changes'}</button>)}</div>
        <div className="region-selection-actions"><span>Include in preview</span><button disabled={disabled || included.length === result.proposals.length} onClick={onSelectAll}>All</button><button disabled={disabled || included.length === 0} onClick={onSelectNone}>None</button></div>
        <div className="region-cards" role="group" aria-label="Suggested regions">{result.proposals.map(proposal => <div key={proposal.id} className={`region-card ${selected.has(proposal.id) ? 'included' : 'skipped'}`}>
          <label><input type="checkbox" checked={selected.has(proposal.id)} disabled={disabled} onChange={() => onToggle(proposal.id)} aria-label={`Include region ${proposal.id}`} /><span><strong>Region {proposal.id}</strong><small>{proposal.removedPixels.toLocaleString()} pixel changes</small></span></label>
          <button disabled={disabled} onClick={() => onFocus(proposal.id)} aria-label={`Inspect region ${proposal.id}`}>Inspect <span aria-hidden="true">↗</span></button>
        </div>)}</div>
        <p className="region-note">Inspect each area to keep intentional shading and details. Unchecked regions stay unchanged.</p>
        <button className="region-primary-button" disabled={disabled || !included.length || !changedPixels} onClick={onApply}>Apply selected regions <span aria-hidden="true">✓</span></button>
        <button className="region-secondary-button" disabled={disabled} onClick={onDiscard}>Discard preview</button>
      </> : <><p className="region-note">The scan did not propose a flat-fill area. Your current canvas is unchanged.</p><button className="region-secondary-button" disabled={disabled} onClick={onDiscard}>Close region review</button></>}
      <p className={`region-scan-note ${result.scannedPixels < result.totalPixels ? 'partial' : ''}`}>{result.scannedPixels < result.totalPixels ? `${result.scannedPixels.toLocaleString()} of ${result.totalPixels.toLocaleString()} pixels scanned · partial coverage` : 'Full canvas scanned'} · {(result.elapsedMs / 1000).toFixed(1)}s</p>
      {result.limited && <p className="region-note">Some candidate areas could not be outlined within this scan. The displayed regions are not a complete list.</p>}
    </>}
  </section>;
}
