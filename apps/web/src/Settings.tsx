import { useState } from 'react';
import type { WorkspaceSettings } from '../../../packages/app-model/src';
import type { MachineProfile } from '../../../packages/core/src/types';
import { paletteSchema, profileSchema } from '../../../packages/core/src/schemas';
import { hexToRgb, Icon, Notice, request, rgbToHex, ScreenHeader, Spinner } from './ui';
import './library.css';

interface Props { settings: WorkspaceSettings; onSaved: (settings: WorkspaceSettings) => void; onCancel: () => void }
export default function Settings({ settings, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<WorkspaceSettings>(() => structuredClone(settings));
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [removeId, setRemoveId] = useState<string | null>(null);
  const updateProfile = (id: string, changes: Partial<MachineProfile>) => setDraft(value => ({ ...value, profiles: value.profiles.map(profile => profile.id === id ? { ...profile, ...changes } : profile) }));
  function addProfile() {
    const id = crypto.randomUUID();
    setDraft(value => ({ ...value, profiles: [...value.profiles, { id, name: 'New machine', hooks: 2400, epi: 60, ppi: 48 }], defaultProfileId: value.defaultProfileId || id }));
  }
  function removeProfile(id: string) {
    if (draft.profiles.length < 2) { setError('Keep at least one machine profile in this workspace.'); return; }
    if (draft.defaultProfileId === id) { setError('Choose another default machine before removing this profile.'); return; }
    setDraft(value => ({ ...value, profiles: value.profiles.filter(profile => profile.id !== id) })); setRemoveId(null);
  }
  async function save() {
    setError('');
    try {
      if (!draft.name.trim()) throw new Error('Give your workspace a name.');
      if (!draft.profiles.length || !draft.profiles.some(profile => profile.id === draft.defaultProfileId)) throw new Error('Choose a default machine profile.');
      if (draft.profiles.some(profile => !profile.name.trim())) throw new Error('Every machine profile needs a name.');
      for (const profile of draft.profiles) profileSchema.parse(profile);
      paletteSchema.parse(draft.defaultPalette);
      if (draft.defaultPalette.entries.some(entry => !entry.name.trim())) throw new Error('Give each palette color a name.');
      setSaving(true);
      const next = { ...draft, name: draft.name.trim(), profiles: draft.profiles.map(profile => ({ ...profile, name: profile.name.trim() })) };
      const saved = await request<WorkspaceSettings>('/api/workspace', { method: 'PUT', body: JSON.stringify(next) }); onSaved(saved ?? next);
    } catch (error) {
      const validation = error as { issues?: { message: string }[]; message: string };
      setError(validation.issues ? 'Check the machine values and colors. Hooks must be a positive whole number; EPI and PPI must be greater than zero.' : validation.message);
    } finally { setSaving(false); }
  }
  return <main className="jdm-settings jdm-screen">
    <ScreenHeader eyebrow="YOUR LOCAL WORKSPACE" title="Workspace settings" description="Set the machines and colors you start every design with." back={saving ? undefined : onCancel}><button className="jdm-button" onClick={onCancel} disabled={saving}>Cancel</button><button className="jdm-button jdm-button-primary" onClick={() => void save()} disabled={saving}>{saving ? <Spinner label="Saving…" /> : <><Icon name="check" /> Save settings</>}</button></ScreenHeader>
    {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
    <section className="jdm-settings-section"><div className="jdm-section-intro"><div className="jdm-section-number">01</div><h2>Workspace</h2><p>A familiar name for this computer's design library.</p></div><div className="jdm-settings-body"><label className="jdm-field">Workspace name<input className="jdm-input" value={draft.name} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} placeholder="Your studio" maxLength={120} /></label><div className="jdm-fine jdm-local-note"><span className="jdm-local-dot" /> Designs and settings are stored on this computer.</div></div></section>
    <section className="jdm-settings-section"><div className="jdm-section-intro"><div className="jdm-section-number">02</div><h2>Machine profiles</h2><p>Hooks set the available width. EPI and PPI control the physical size of every export.</p><p className="jdm-fine">Profiles used by saved designs must remain available.</p></div><div className="jdm-settings-body jdm-profiles">
      {draft.profiles.map(profile => <article className="jdm-profile-card" key={profile.id}><div className="jdm-profile-title"><label className="jdm-field">Machine name<input className="jdm-input" value={profile.name} onChange={event => updateProfile(profile.id, { name: event.target.value })} /></label><label className="jdm-default-profile"><input type="radio" name="default-profile" checked={draft.defaultProfileId === profile.id} onChange={() => setDraft(value => ({ ...value, defaultProfileId: profile.id }))} /> Default</label></div><div className="jdm-profile-values"><label className="jdm-field">Total hooks<input className="jdm-input" type="number" min="1" step="1" value={profile.hooks || ''} onChange={event => updateProfile(profile.id, { hooks: Number(event.target.value) })} /></label><label className="jdm-field">EPI <span className="jdm-fine">ends / inch</span><input className="jdm-input" type="number" min="0.01" step="any" value={profile.epi || ''} onChange={event => updateProfile(profile.id, { epi: Number(event.target.value) })} /></label><label className="jdm-field">PPI <span className="jdm-fine">picks / inch</span><input className="jdm-input" type="number" min="0.01" step="any" value={profile.ppi || ''} onChange={event => updateProfile(profile.id, { ppi: Number(event.target.value) })} /></label></div><label className="jdm-field">Notes <span className="jdm-fine">optional</span><input className="jdm-input" value={profile.notes ?? ''} onChange={event => updateProfile(profile.id, { notes: event.target.value })} placeholder="Loom, fabric, or setup notes" /></label>{removeId === profile.id ? <div className="jdm-inline-confirm"><span>Remove this profile?</span><div><button className="jdm-button jdm-button-small" onClick={() => setRemoveId(null)}>Keep</button><button className="jdm-button jdm-button-small jdm-button-danger" onClick={() => removeProfile(profile.id)}>Remove</button></div></div> : <button className="jdm-link-button jdm-remove-profile" onClick={() => setRemoveId(profile.id)} disabled={saving}>Remove profile</button>}</article>)}
      <button className="jdm-button jdm-button-add" onClick={addProfile}><Icon name="plus" /> Add a machine profile</button>
    </div></section>
    <section className="jdm-settings-section"><div className="jdm-section-intro"><div className="jdm-section-number">03</div><h2>Starting palette</h2><p>Up to six colors total, including ground and outlines. These defaults apply to new masters.</p><p className="jdm-fine">Display colors are used in the editor. Export colors are written into PNG and BMP files.</p></div><div className="jdm-settings-body"><div className="jdm-palette-head"><span>Slot / name</span><span>Display</span><span>Export</span></div>{draft.defaultPalette.entries.map((entry, index) => <div className="jdm-palette-row" key={entry.index}><label className="jdm-palette-name"><span className="jdm-color-index" style={{ background: rgbToHex(entry.displayRgb) }}>{entry.index}</span><input className="jdm-input" aria-label={`Color ${entry.index} name`} value={entry.name} onChange={event => setDraft(value => ({ ...value, defaultPalette: { entries: value.defaultPalette.entries.map((color, i) => i === index ? { ...color, name: event.target.value } : color) } }))} /></label><label className="jdm-color-input"><input type="color" aria-label={`${entry.name} display color`} value={rgbToHex(entry.displayRgb)} onChange={event => setDraft(value => ({ ...value, defaultPalette: { entries: value.defaultPalette.entries.map((color, i) => i === index ? { ...color, displayRgb: hexToRgb(event.target.value) } : color) } }))} /><span>{rgbToHex(entry.displayRgb).toUpperCase()}</span></label><label className="jdm-color-input"><input type="color" aria-label={`${entry.name} export color`} value={rgbToHex(entry.exportRgb)} onChange={event => setDraft(value => ({ ...value, defaultPalette: { entries: value.defaultPalette.entries.map((color, i) => i === index ? { ...color, exportRgb: hexToRgb(event.target.value) } : color) } }))} /><span>{rgbToHex(entry.exportRgb).toUpperCase()}</span></label></div>)}{draft.defaultPalette.entries.length < 6 && <button className="jdm-button jdm-button-add" onClick={() => setDraft(value => ({ ...value, defaultPalette: { entries: [...value.defaultPalette.entries, { index: value.defaultPalette.entries.length, name: 'New color', displayRgb: [90, 105, 98], exportRgb: [90, 105, 98] }] } }))}><Icon name="plus" /> Add palette color</button>}<p className="jdm-fine">Slot 0 is ground. Existing masters keep their own palettes.</p></div></section>
  </main>;
}
