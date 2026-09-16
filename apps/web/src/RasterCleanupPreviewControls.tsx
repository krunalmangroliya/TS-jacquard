import {useEffect,useState} from 'react';
import type {Palette,RuleConfig} from '../../../packages/core/src/types';
import {gentleCleanupRules,lineRepairRules} from './cleanup-preview';

/** These controls prepare proposals; changing a draft never edits the saved size. */
export default function RasterCleanupPreviewControls({rules,palette,disabled,onPreview}:{rules:RuleConfig;palette:Palette;disabled:boolean;onPreview:(rules:RuleConfig,title:string)=>void}){
  const [limit,setLimit]=useState('1'),[colors,setColors]=useState<number[]>(rules.repairColorIndices??[]);
  const paletteKey=JSON.stringify(palette),savedColors=JSON.stringify(rules.repairColorIndices??[]);
  useEffect(()=>setColors(rules.repairColorIndices??[]),[paletteKey,savedColors]);
  const maximum=Number(limit),valid=limit.trim()!==''&&Number.isInteger(maximum)&&maximum>=1&&maximum<=64;
  return <div className="cleanup-preview-controls">
    <label className="field">Small-region limit · pixels<input type="number" min="1" max="64" step="1" value={limit} disabled={disabled} onChange={event=>setLimit(event.target.value)}/></label>
    <button className="full" disabled={disabled||!valid} onClick={()=>onPreview(gentleCleanupRules(rules,maximum),maximum===1?'Gentle cleanup preview':`Small-region preview · up to ${maximum} pixels`)}>{maximum===1?'Preview gentle cleanup':'Preview small regions'}</button>
    <p className="muted">Start with 1 pixel. Larger limits can remove decoration. Select an area and colors below to review a particular stray mark. This proposal replaces the current cleanup settings and may restore detail. Your palette, scope and Pixel pencil corrections are retained.</p>
    {!valid&&<p className="warning-text">Choose a whole number from 1 to 64.</p>}
    <details><summary>Repair multiple line colors</summary>
      <p className="muted">Choose the colors of interrupted lines, such as gold and cream. Up to 8 colors are checked against the source together. Existing speck settings and sampling are retained.</p>
      <div className="cleanup-color-list" aria-label="Line colors to repair">{palette.entries.map(entry=><label className="check-row" key={entry.index}><input type="checkbox" aria-label={`Repair color ${entry.index}: ${entry.name}`} checked={colors.includes(entry.index)} disabled={disabled||colors.length>=8&&!colors.includes(entry.index)} onChange={event=>setColors(old=>event.target.checked?[...old,entry.index]:old.filter(index=>index!==entry.index))}/><span className="cleanup-color-swatch" style={{background:`rgb(${entry.exportRgb.join(',')})`}}/>{entry.index} · {entry.name}</label>)}</div>
      <p className="muted">{colors.length} / 8 line colors selected · preview before applying.</p>
      <button className="full" disabled={disabled||colors.length===0} onClick={()=>onPreview(lineRepairRules(rules,colors,palette.entries.length),'Selected line repair preview')}>Preview selected line repairs</button>
    </details>
    {(rules.rasterResize==='preserve-outline'||rules.repairOutlineGaps)&&rules.outlineAlgorithm!=='conservative'&&<button className="full" disabled={disabled} onClick={()=>onPreview({...rules,outlineAlgorithm:'conservative'},'Conservative outline preview')}>Preview conservative outline update</button>}
  </div>;
}
