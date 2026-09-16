import type { AiResult } from './ai-types';
import type { Progress } from './types';

export type AiView = 'before' | 'proposal' | 'changes';

interface Props {
  progress: Progress | null;
  result: AiResult | null;
  view: AiView;
  error: string;
  disabled: boolean;
  settingsChanged: boolean;
  onRun: () => void;
  onCancel: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onView: (view: AiView) => void;
}

export default function AiReview({ progress, result, view, error, disabled, settingsChanged, onRun, onCancel, onApply, onDiscard, onView }: Props) {
  const changes = result ? result.stats.addedPixels + result.stats.removedPixels : 0;
  const limited = result && (result.stats.patchesScanned < result.stats.eligiblePatches || result.stats.scannedPixels < result.stats.totalPixels);
  return <section className="ai-review" aria-labelledby="ai-review-title" aria-busy={progress !== null}>
    <div className="ai-review-heading"><h3 id="ai-review-title">AI cleanup trial</h3><span>Experimental</span></div>
    {!progress && !result && <>
      <p>A small local model can propose extra pixel edits. Review its suggestions before applying them.</p>
      <button className="ai-run-button" disabled={disabled || settingsChanged} onClick={onRun}>Run AI trial <span aria-hidden="true">↗</span></button>
      <p className="ai-note">{settingsChanged ? 'Reprocess your changed recipe before starting a trial.' : 'Starts from your current canvas. Your existing cleanup stays available.'}</p>
    </>}
    {progress && <div className="ai-running" role="status">
      <p>{progress.stage}</p>
      <div className="progress-track" role="progressbar" aria-label="AI trial progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percent)}><i style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div>
      <p className="ai-note">Checking the canvas on this device. Edits are paused; you can still pan and zoom.</p>
      <button className="ai-secondary-button" onClick={onCancel}>Cancel AI trial</button>
    </div>}
    {error && <p className="ai-error" role="alert">{error}</p>}
    {result && <>
      <p className="ai-preview-status" role="status">{changes ? 'Preview only · not applied' : 'No additional changes proposed'}</p>
      <dl className="ai-metrics"><div><dt>Pixels removed</dt><dd>{result.stats.removedPixels.toLocaleString()}</dd></div><div><dt>Pixels added</dt><dd>{result.stats.addedPixels.toLocaleString()}</dd></div></dl>
      <p className={`ai-coverage ${limited ? 'limited' : ''}`}>{limited && <strong>Limited coverage. </strong>}{result.stats.patchesScanned.toLocaleString()} of {result.stats.eligiblePatches.toLocaleString()} found candidate patches checked. Areas outside these patches have not been reviewed by AI.{result.stats.scannedPixels < result.stats.totalPixels && ' Candidate search also sampled part of this large canvas.'}</p>
      <div className="ai-view-buttons" role="group" aria-label="AI comparison view">{(['before', 'proposal', 'changes'] as const).map(value => <button key={value} aria-pressed={view === value} className={view === value ? 'active' : ''} onClick={() => onView(value)}>{value === 'before' ? 'Before AI' : value === 'proposal' ? 'Proposed' : 'AI changes'}</button>)}</div>
      <p className="ai-note">Zoom in to check fine lines and deliberate dots. These suggestions may be wrong.</p>
      <button className="ai-apply-button" disabled={!changes} onClick={onApply}>Apply AI changes</button>
      <button className="ai-secondary-button" onClick={onDiscard}>{changes ? 'Discard preview' : 'Close preview'}</button>
      {result.warnings.length > 0 && <details className="ai-warnings"><summary>Trial limitations ({result.warnings.length})</summary>{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      <details className="ai-model-details"><summary>Trial details</summary><p>{result.stats.modelName} · {result.stats.provider}<br />{(result.stats.elapsedMs / 1000).toFixed(1)} seconds · {result.stats.candidatePixels.toLocaleString()} candidate pixels</p><p>Experimental model. These counts do not measure cleanup accuracy.</p></details>
    </>}
  </section>;
}
