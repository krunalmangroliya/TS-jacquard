import {useMemo} from 'react';
import type {Palette, PaletteEntry} from '../../../packages/core/src/types';
import {analyzePaletteUsage, formatColorUsagePercentage, LOW_COLOR_USAGE_PERCENT} from './palette-usage';
import './palette-usage.css';

export interface PaletteUsageNoticeProps {
  palette: Palette;
  counts: readonly number[] | undefined;
  totalPixels: number;
  onReview: (sourceIndex: number, targetIndex?: number) => void;
  disabled?: boolean;
  pending?: boolean;
  basis: 'source' | 'output';
}

function ColorChip({entry}: {entry: PaletteEntry}) {
  const hex = `#${entry.exportRgb.map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return <span className="palette-usage-color"><span className="palette-usage-swatch" style={{background: `rgb(${entry.exportRgb.join(',')})`}} aria-hidden="true"/><span>{entry.index} · {entry.name}<small>{hex}</small></span></span>;
}

export function PaletteUsageNotice({palette, counts, totalPixels, onReview, disabled = false, pending = false, basis}: PaletteUsageNoticeProps) {
  const analysis = useMemo(() => pending ? undefined : analyzePaletteUsage(palette, counts, totalPixels), [palette, counts, totalPixels, pending]);
  const imageLabel = basis === 'source' ? 'source image' : 'final output';
  return <div className="palette-usage-notice" aria-label="Color usage review">
    <h3>Low-use colors</h3>
    {pending ? <p className="muted" role="status">Counting colors in the {imageLabel}…</p> : !analysis ? <p className="muted">Color counts are not available for the {imageLabel} yet.</p> : <>
      <p className="palette-usage-basis">{analysis.totalPixels.toLocaleString()} {imageLabel} pixels{basis === 'output' ? ' · after cleanup and pixel edits' : ''}</p>
      <p className="muted">Review colors used in {LOW_COLOR_USAGE_PERCENT}% or less of this image. Small accents can be intentional. Colors are kept until you merge them.</p>
      {analysis.rare.length > 0 ? <ul className="palette-usage-list">
        {analysis.rare.map(({entry, pixelCount, percentage, canMerge, suggestedTarget}) => <li key={entry.index}>
          <ColorChip entry={entry}/>
          <p className="palette-usage-count">{pixelCount.toLocaleString()} pixels · {formatColorUsagePercentage(percentage)}</p>
          {suggestedTarget && <div className="palette-usage-suggestion"><small>Similar, more common export shade</small><ColorChip entry={suggestedTarget}/></div>}
          {canMerge ? <button className="text-button" disabled={disabled} onClick={() => onReview(entry.index, suggestedTarget?.index)} aria-label={`Review merge for color ${entry.index}: ${entry.name}`}>Review merge →</button> : <p className="muted">Ground is reserved and cannot be merged into another color.</p>}
        </li>)}
      </ul> : <p className="muted">No used colors fall below this review threshold.</p>}
      {analysis.unused.length > 0 && <details className="palette-usage-unused"><summary>{analysis.unused.length} unused {analysis.unused.length === 1 ? 'color' : 'colors'} · 0 pixels</summary><p className="muted">These palette entries have no pixels in this {imageLabel}.</p><ul className="palette-usage-list">{analysis.unused.map(entry => <li key={entry.index}><ColorChip entry={entry}/></li>)}</ul></details>}
    </>}
  </div>;
}
